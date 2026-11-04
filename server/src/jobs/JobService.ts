import type { Actor } from '../../framework/core/actor.js';
import { ApplicationError } from '../../framework/core/errors.js';
import type { JobRepository } from './JobRepository.js';
import { jobStatuses, twinKey } from './JobTypes.js';
import type { JobDecision, JobFoundResult, JobInput, JobPipelineApi, JobScore, JobStatus, PipelineJob } from './JobTypes.js';

export { jobStatuses } from './JobTypes.js';
export type { JobDecision, JobInput, JobScore, JobStatus, PipelineJob } from './JobTypes.js';

const jobDecisions: readonly JobDecision[] = ['queued', 'rejected', 'skipped'];

/**
 * A job in one of these statuses, rejected after a score (by the model), or already sent to Job-Tracker
 * makes a same-named job a repeat. A job rejected by the title filter has no score and is not a twin.
 */
const twinStatuses: readonly JobStatus[] = ['scored', 'queued', 'applying', 'applied', 'needs_input'];

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

export type Job = PipelineJob & Readonly<{ foundAt: string; updatedAt: string }>;
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

export type NewJob = Readonly<{
  url: string; source: string; title: string; company: string; externalId: string | null;
  location: string | null; description: string | null; postedAt: Date | null; raw: string | null;
  status: 'found' | 'rejected'; why: string | null;
}>;

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
  const rejection = input.rejection?.trim() || null;
  if (!title || (!company && !rejection) || !source) throw new ApplicationError('INVALID_JOB', 'Нужны название, компания и источник.', 400);
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
    status: rejection ? 'rejected' : 'found',
    why: rejection,
  };
}

export class JobService implements JobPipelineApi {
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
    const job = await this.jobs.create(actor.id, newJob({ ...input, source: input.source ?? 'manual', rejection: null }));
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

  async recordFound(ownerId: string, inputs: readonly JobInput[]): Promise<JobFoundResult> {
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
    const profileRevision = input.profileRevision ?? null;
    if (profileRevision !== null && !Number.isSafeInteger(profileRevision)) {
      throw new ApplicationError('INVALID_JOB_SCORE', 'Ревизия профиля — целое число.', 400);
    }
    return this.changed(await this.jobs.update(ownerId, id, job.status, {
      status: 'scored', score: input.score, why: input.why?.trim() || null, redFlags, profileRevision,
    }));
  }

  async listForScoring(ownerId: string, limit?: number): Promise<Job[]> {
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
      throw new ApplicationError('INVALID_QUERY', 'limit — целое число от 1.', 400);
    }
    return this.jobs.listForScoring(ownerId, limit);
  }

  async findTwin(ownerId: string, company: string, title: string, exceptId: string): Promise<Job | null> {
    const key = twinKey(company, title);
    const candidates = await this.jobs.listTwinCandidates(ownerId, exceptId, twinStatuses);
    const twin = candidates.find((candidate) => twinKey(candidate.company, candidate.title) === key);
    return twin ? this.jobs.find(ownerId, twin.id) : null;
  }

  async recordDecision(ownerId: string, id: string, status: JobDecision, why?: string): Promise<Job> {
    if (!jobDecisions.includes(status)) {
      throw new ApplicationError('INVALID_JOB_STATUS', 'Решение — queued, rejected или skipped.', 400);
    }
    const job = await this.owned(ownerId, id);
    requireTransition(job.status, status);
    return this.changed(await this.jobs.update(ownerId, id, job.status, {
      status, ...(why !== undefined ? { why: why.trim() || null } : {}),
    }));
  }

  listUnsynced(ownerId: string): Promise<Job[]> {
    return this.jobs.listUnsynced(ownerId);
  }

  async markSynced(ownerId: string, id: string, trackerId: string): Promise<Job> {
    const value = trackerId.trim();
    if (!value) throw new ApplicationError('INVALID_TRACKER_ID', 'Нужен ID вакансии в Job-Tracker.', 400);
    const job = await this.owned(ownerId, id);
    if (job.trackerId === value) return job;
    const synced = job.trackerId === null ? await this.jobs.setTrackerId(ownerId, id, value) : null;
    if (!synced) throw new ApplicationError('JOB_ALREADY_SYNCED', 'Вакансия уже связана с другой записью Job-Tracker.', 409);
    return synced;
  }

  findByTrackerId(ownerId: string, trackerId: string): Promise<Job | null> {
    return this.jobs.findByTrackerId(ownerId, trackerId.trim());
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
