import type { Actor } from '../../framework/core/actor.js';
import { ApplicationError } from '../../framework/core/errors.js';
import type { JobRepository } from './JobRepository.js';

export const jobStatuses = [
  'found', 'scored', 'rejected', 'queued', 'applying', 'applied', 'needs_input', 'failed', 'skipped',
] as const;
export type JobStatus = typeof jobStatuses[number];

/** A person may only queue, reject or skip; other statuses come from the scorer and the applier. */
export const userJobStatuses = ['queued', 'rejected', 'skipped'] as const;
export type UserJobStatus = typeof userJobStatuses[number];

const transitions: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  found: ['scored', 'queued', 'rejected', 'skipped'],
  scored: ['scored', 'queued', 'rejected', 'skipped'],
  rejected: ['scored', 'queued', 'skipped'],
  queued: ['applying', 'rejected', 'skipped'],
  applying: ['applied', 'needs_input', 'failed'],
  needs_input: ['queued', 'applying', 'skipped'],
  failed: ['queued', 'skipped'],
  skipped: ['queued'],
  applied: [],
};

export type Job = Readonly<{
  id: string;
  url: string;
  source: string;
  externalId: string | null;
  company: string;
  title: string;
  location: string | null;
  description: string | null;
  score: number | null;
  why: string | null;
  redFlags: string[];
  status: JobStatus;
  postedAt: string | null;
  foundAt: string;
  updatedAt: string;
}>;
/** Lists omit the long description. */
export type JobSummary = Omit<Job, 'description'>;
export type JobPage = Readonly<{ items: JobSummary[]; total: number; page: number; limit: number }>;

export type JobListQuery = Readonly<{
  page?: number;
  limit?: number;
  status?: JobStatus;
  source?: string;
  search?: string;
  sort?: 'found' | 'score';
}>;

/** A job card from a source module or from manual input. */
export type JobInput = Readonly<{
  url: string;
  source: string;
  title: string;
  company: string;
  externalId?: string | null;
  location?: string | null;
  description?: string | null;
  postedAt?: Date | null;
  /** Source-specific fields; stored as JSON and never returned over HTTP. */
  raw?: unknown;
}>;
export type NewJob = Readonly<{
  url: string; source: string; title: string; company: string; externalId: string | null;
  location: string | null; description: string | null; postedAt: Date | null; raw: string | null;
}>;

export type JobScore = Readonly<{ score: number; why?: string | null; redFlags?: readonly string[] }>;

/** Only http(s), no fragment, no credentials. Source modules strip their own tracking parameters. */
export function canonicalJobUrl(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); } catch {
    throw new ApplicationError('INVALID_JOB_URL', 'Укажите корректный адрес вакансии.', 400);
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new ApplicationError('INVALID_JOB_URL', 'Адрес вакансии должен начинаться с http:// или https://.', 400);
  }
  url.hash = '';
  return url.toString();
}

export function requireTransition(from: JobStatus, to: JobStatus): void {
  if (!transitions[from].includes(to)) {
    throw new ApplicationError('INVALID_JOB_STATUS', `Нельзя перевести вакансию из «${from}» в «${to}».`, 409);
  }
}

function newJob(input: JobInput): NewJob {
  const title = input.title.trim();
  const company = input.company.trim();
  const source = input.source.trim().toLowerCase();
  if (!title || !company || !source) throw new ApplicationError('INVALID_JOB', 'Нужны название, компания и источник.', 400);
  return {
    url: canonicalJobUrl(input.url),
    source,
    title,
    company,
    externalId: input.externalId?.trim() || null,
    location: input.location?.trim() || null,
    description: input.description?.trim() || null,
    postedAt: input.postedAt ?? null,
    raw: input.raw === undefined ? null : JSON.stringify(input.raw),
  };
}

export class JobService {
  constructor(private readonly jobs: JobRepository) {}

  // ── Owner's actions over HTTP ──

  list(actor: Actor, query: JobListQuery = {}): Promise<JobPage> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    if (!Number.isSafeInteger(page) || !Number.isSafeInteger(limit) || page < 1 || limit < 1 || limit > 100) {
      throw new ApplicationError('INVALID_QUERY', 'page — от 1, limit — от 1 до 100.', 400);
    }
    return this.jobs.list(actor.id, { ...query, page, limit });
  }

  async summary(actor: Actor): Promise<{ total: number; counts: Record<JobStatus, number> }> {
    const found = await this.jobs.countByStatus(actor.id);
    const counts = Object.fromEntries(jobStatuses.map((status) => [status, found[status] ?? 0])) as Record<JobStatus, number>;
    return { total: Object.values(counts).reduce((sum, count) => sum + count, 0), counts };
  }

  get(actor: Actor, id: string): Promise<Job> {
    return this.owned(actor.id, id);
  }

  async create(actor: Actor, input: Omit<JobInput, 'source'> & { source?: string }): Promise<Job> {
    const job = await this.jobs.create(actor.id, newJob({ ...input, source: input.source ?? 'manual' }));
    if (!job) throw new ApplicationError('JOB_EXISTS', 'Эта вакансия уже есть в вашем списке.', 409);
    return job;
  }

  async changeStatus(actor: Actor, id: string, status: UserJobStatus): Promise<Job> {
    if (!userJobStatuses.includes(status)) {
      throw new ApplicationError('INVALID_JOB_STATUS', 'Вручную можно поставить в очередь, отклонить или пропустить вакансию.', 400);
    }
    return this.recordStatus(actor.id, id, status);
  }

  async remove(actor: Actor, id: string): Promise<void> {
    if (!await this.jobs.delete(actor.id, id)) throw new ApplicationError('JOB_NOT_FOUND', 'Вакансия не найдена.', 404);
  }

  // ── Pipeline stages (collector, scorer, applier) act on behalf of the owner ──

  /** Saves new cards; a broken card is counted and skipped instead of failing the batch. */
  async recordFound(ownerId: string, inputs: readonly JobInput[]) {
    const jobIds: string[] = [];
    let duplicates = 0;
    let invalid = 0;
    for (const input of inputs) {
      let job: NewJob;
      try { job = newJob(input); } catch { invalid++; continue; }
      const created = await this.jobs.create(ownerId, job);
      if (created) jobIds.push(created.id);
      else duplicates++;
    }
    return { created: jobIds.length, duplicates, invalid, jobIds };
  }

  /** URLs the owner has not seen yet, so the collector loads details only for new jobs. */
  async unknownUrls(ownerId: string, urls: readonly string[]): Promise<string[]> {
    const valid = urls.flatMap((url) => { try { return [{ url, canonical: canonicalJobUrl(url) }]; } catch { return []; } });
    const known = new Set(await this.jobs.existingUrls(ownerId, valid.map((item) => item.canonical)));
    return valid.filter((item) => !known.has(item.canonical)).map((item) => item.url);
  }

  async recordScore(ownerId: string, id: string, input: JobScore): Promise<Job> {
    if (!Number.isInteger(input.score) || input.score < 0 || input.score > 100) {
      throw new ApplicationError('INVALID_JOB_SCORE', 'Оценка — целое число от 0 до 100.', 400);
    }
    const job = await this.owned(ownerId, id);
    requireTransition(job.status, 'scored');
    const redFlags = (input.redFlags ?? []).map((flag) => flag.trim()).filter(Boolean);
    return this.changed(await this.jobs.update(ownerId, id, job.status, {
      status: 'scored', score: input.score, why: input.why?.trim() || null, redFlags,
    }));
  }

  async recordStatus(ownerId: string, id: string, status: JobStatus): Promise<Job> {
    const job = await this.owned(ownerId, id);
    requireTransition(job.status, status);
    return this.changed(await this.jobs.update(ownerId, id, job.status, { status }));
  }

  private async owned(ownerId: string, id: string): Promise<Job> {
    const job = await this.jobs.find(ownerId, id);
    if (!job) throw new ApplicationError('JOB_NOT_FOUND', 'Вакансия не найдена.', 404);
    return job;
  }

  /** The update is conditional on the old status; null means another process changed it first. */
  private changed(job: Job | null): Job {
    if (!job) throw new ApplicationError('JOB_STATUS_CHANGED', 'Статус вакансии уже изменился. Обновите страницу.', 409);
    return job;
  }
}
