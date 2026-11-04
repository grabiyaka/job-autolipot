import type { Actor } from '../../framework/core/actor.js';
import { ApplicationError } from '../../framework/core/errors.js';
import type { Clock } from '../../framework/core/runtime.js';
import type { JobPipelineApi, PipelineJob } from '../jobs/JobTypes.js';
import type { UserApi } from '../users/UserTypes.js';
import type { TrackerRepository } from './TrackerRepository.js';
import { trackerBatchLimit, TrackerError } from './TrackerTypes.js';
import type {
  JobTrackerClient, TrackerApi, TrackerEvaluationInput, TrackerJobInput, TrackerProfile, TrackerPushOptions,
  TrackerPushReport, TrackerPushResult, TrackerUser, TrackerVerdict,
} from './TrackerTypes.js';

export type StoredTrackerProfile = Readonly<{ revision: number; etag: string | null; markdown: string; fetchedAt: Date }>;

export type TrackerStatus = Readonly<{
  configured: boolean;
  /** Whether this user is the one the JT token belongs to; null when JT could not be asked. */
  linked: boolean | null;
  profile: Readonly<{ revision: number; fetchedAt: string }> | null;
  error: string | null;
}>;

export type TrackerProfileView = Readonly<{ markdown: string; revision: number; fetchedAt: string; fromCache: boolean }>;

const evaluatorName = 'job-autopilot';
const skipReasons = { duplicate_opportunity: 'уже в Job-Tracker', already_applied: 'уже подавался' } as const;

/** JT's verdict vocabulary over our 0–100 score. */
export function trackerVerdict(score: number): TrackerVerdict {
  if (score >= 80) return 'STRONG_FIT';
  if (score >= 70) return 'GOOD_FIT';
  if (score >= 50) return 'WEAK_FIT';
  return 'NOT_A_FIT';
}

const present = (value: string | null): string | undefined => (value?.trim() ? value : undefined);

/** Field names and limits of JT's `POST /api/ai/jobs`; empty values are left out. */
export function trackerJob(job: PipelineJob): TrackerJobInput {
  const optional = {
    jobDescription: present(job.description)?.slice(0, 100_000),
    location: present(job.location),
    source: job.source,
    externalId: present(job.externalId),
    postedAt: present(job.postedAt),
  };
  const defined = Object.entries(optional).filter((entry): entry is [string, string] => entry[1] !== undefined);
  return { jobTitle: job.title, companyName: job.company, vacancyUrl: job.url, ...Object.fromEntries(defined) };
}

/** Null when there is nothing JT can take: no score, or no profile revision it was made against. */
export function trackerEvaluation(job: PipelineJob, options: TrackerPushOptions): TrackerEvaluationInput | null {
  if (job.score === null || job.profileRevision === null) return null;
  return {
    score: job.score,
    verdict: trackerVerdict(job.score),
    summary: (present(job.why) ?? `Оценка ${job.score}/100.`).slice(0, 20_000),
    profileRevision: job.profileRevision,
    evaluatorName,
    redFlags: job.redFlags.slice(0, 100),
    ...(options.model ? { model: options.model } : {}),
  };
}

function profileView(profile: StoredTrackerProfile, fromCache: boolean): TrackerProfile {
  return { markdown: profile.markdown, revision: profile.revision, fetchedAt: profile.fetchedAt, fromCache };
}

const isOutage = (error: unknown): error is TrackerError =>
  error instanceof TrackerError && (error.kind === 'unavailable' || error.kind === 'rate_limited');

/**
 * Everything this app does with Job-Tracker. One JT token belongs to one JT user, so only the
 * user of this app with the same email may use it; for everyone else the tracker does not exist.
 */
export class TrackerService implements TrackerApi {
  /** The JT user of the token; it does not change while the process runs. */
  private tokenOwner: Promise<TrackerUser> | null = null;

  constructor(
    private readonly profiles: TrackerRepository,
    private readonly client: JobTrackerClient | null,
    private readonly jobs: JobPipelineApi,
    private readonly users: Pick<UserApi, 'profile'>,
    private readonly clock: Clock,
  ) {}

  // ── Owner's actions over HTTP ──

  async status(actor: Actor): Promise<TrackerStatus> {
    if (!this.client) return { configured: false, linked: false, profile: null, error: null };
    let linked: boolean | null;
    let error: string | null = null;
    try {
      linked = await this.isLinked(this.client, actor.id);
    } catch (failure) {
      if (!(failure instanceof TrackerError)) throw failure;
      linked = null;
      error = failure.message;
    }
    const stored = linked === false ? null : await this.profiles.findProfile(actor.id);
    const profile = stored && { revision: stored.revision, fetchedAt: stored.fetchedAt.toISOString() };
    return { configured: true, linked, profile, error };
  }

  /** The stored copy as is, unless `refresh` or there is none yet; then it is fetched from JT. */
  async currentProfile(actor: Actor, refresh = false): Promise<TrackerProfileView> {
    const client = this.requireClient();
    const stored = refresh ? null : await this.profiles.findProfile(actor.id);
    let profile: TrackerProfile;
    if (stored) {
      await this.requireLinked(client, actor.id).catch((error: unknown) => { if (!isOutage(error)) throw this.failure(error); });
      profile = profileView(stored, true);
    } else {
      profile = await this.profile(actor.id);
    }
    return { ...profile, fetchedAt: profile.fetchedAt.toISOString() };
  }

  async push(actor: Actor): Promise<TrackerPushReport> {
    return this.pushQueued(actor.id);
  }

  // ── Pipeline: scoring calls these on behalf of the owner ──

  async profile(ownerId: string): Promise<TrackerProfile> {
    const client = this.requireClient();
    const stored = await this.profiles.findProfile(ownerId);
    try {
      await this.requireLinked(client, ownerId);
      const context = await client.profileContext(stored?.etag);
      const fetchedAt = this.clock.now();
      if (context.status === 'not_modified') {
        // JT answers 304 only to the ETag we sent, so the stored copy exists here.
        if (!stored) throw new TrackerError('rejected', 'Job-Tracker ответил 304 без сохранённой копии профиля.');
        await this.profiles.touchProfile(ownerId, fetchedAt);
        return profileView({ ...stored, fetchedAt }, false);
      }
      const fresh = { revision: context.revision, etag: context.etag, markdown: context.markdown, fetchedAt };
      await this.profiles.saveProfile(ownerId, fresh);
      return profileView(fresh, false);
    } catch (error) {
      if (stored && isOutage(error)) return profileView(stored, true);
      throw this.failure(error);
    }
  }

  async pushQueued(ownerId: string, options: TrackerPushOptions = {}): Promise<TrackerPushReport> {
    const client = this.requireClient();
    const queued = await this.jobs.listUnsynced(ownerId);
    const report: TrackerPushReport = { created: 0, backfilled: 0, duplicates: 0, alreadyApplied: 0, invalid: [], unevaluated: [], remaining: 0, error: null };
    try {
      await this.requireLinked(client, ownerId);
      await this.sendMissingEvaluations(client, ownerId, options, report);
      const batch = queued.slice(0, trackerBatchLimit);
      if (batch.length) await this.pushBatch(client, ownerId, batch, options, report);
    } catch (error) {
      if (!(error instanceof TrackerError)) throw error;
      report.error = error.message;
    }
    report.remaining = queued.length - report.created - report.duplicates - report.alreadyApplied - report.invalid.length;
    return report;
  }

  /**
   * JT is the source of truth for which of its jobs lack an evaluation: a run that JT stopped between
   * creating a job and taking its evaluation left it there. Jobs of other origin, or without a score,
   * are left alone. At most one batch worth of evaluations per run, for JT's rate limit.
   */
  private async sendMissingEvaluations(
    client: JobTrackerClient, ownerId: string, options: TrackerPushOptions, report: TrackerPushReport,
  ): Promise<void> {
    let cursor: string | null = null;
    do {
      const page = await client.listJobs({ evaluation: 'none', cursor });
      for (const trackerJobId of page.ids) {
        if (report.backfilled >= trackerBatchLimit) return;
        const job = await this.jobs.findByTrackerId(ownerId, trackerJobId);
        const evaluation = job && trackerEvaluation(job, options);
        if (!evaluation) continue;
        await client.recordEvaluation(trackerJobId, evaluation);
        report.backfilled++;
      }
      cursor = page.nextCursor;
    } while (cursor);
  }

  /**
   * Created jobs get their evaluation and are marked as synced; JT's repeats are skipped here.
   * Once JT fails, the rest of the batch is still settled locally (those jobs are already in JT),
   * and the failure is rethrown for the report.
   */
  private async pushBatch(
    client: JobTrackerClient, ownerId: string, batch: readonly PipelineJob[], options: TrackerPushOptions, report: TrackerPushReport,
  ): Promise<void> {
    const results: TrackerPushResult[] = await client.pushJobs(batch.map(trackerJob));
    let failure: TrackerError | null = null;
    for (const result of results) {
      const job = batch[result.index];
      if (!job) continue;
      switch (result.status) {
        case 'created': {
          const evaluation = trackerEvaluation(job, options);
          if (evaluation && !failure) {
            try {
              await client.recordEvaluation(result.jobId, evaluation);
            } catch (error) {
              if (!(error instanceof TrackerError)) throw error;
              failure = error;
            }
          }
          if (evaluation && failure) report.unevaluated.push(job.id);
          await this.jobs.markSynced(ownerId, job.id, result.jobId);
          report.created++;
          break;
        }
        case 'duplicate_opportunity':
          await this.jobs.recordDecision(ownerId, job.id, 'skipped', skipReasons.duplicate_opportunity);
          report.duplicates++;
          break;
        case 'already_applied':
          await this.jobs.recordDecision(ownerId, job.id, 'skipped', skipReasons.already_applied);
          report.alreadyApplied++;
          break;
        case 'invalid':
          report.invalid.push({ jobId: job.id, errors: result.errors });
          break;
      }
    }
    if (failure) throw failure;
  }

  // ── Linking and errors ──

  private requireClient(): JobTrackerClient {
    if (!this.client) throw new ApplicationError('TRACKER_NOT_CONFIGURED', 'Job-Tracker не настроен: задайте JOB_TRACKER_URL и JOB_TRACKER_TOKEN.', 503);
    return this.client;
  }

  private async isLinked(client: JobTrackerClient, ownerId: string): Promise<boolean> {
    this.tokenOwner ??= client.whoami().then(({ user }) => user, (error: unknown) => {
      this.tokenOwner = null;
      throw error;
    });
    const [owner, trackerUser] = await Promise.all([this.users.profile(ownerId), this.tokenOwner]);
    return owner !== null && owner.email.trim().toLowerCase() === trackerUser.email.trim().toLowerCase();
  }

  private async requireLinked(client: JobTrackerClient, ownerId: string): Promise<void> {
    if (!await this.isLinked(client, ownerId)) {
      throw new ApplicationError('TRACKER_NOT_LINKED', 'Job-Tracker не привязан к этому пользователю.', 404);
    }
  }

  private failure(error: unknown): unknown {
    if (!(error instanceof TrackerError)) return error;
    switch (error.kind) {
      case 'unavailable': return new ApplicationError('TRACKER_UNAVAILABLE', error.message, 503);
      case 'rate_limited': return new ApplicationError('TRACKER_RATE_LIMITED', error.message, 503);
      case 'unauthorized': return new ApplicationError('TRACKER_UNAUTHORIZED', error.message, 502);
      case 'rejected': return new ApplicationError('TRACKER_REJECTED', error.message, 502);
    }
  }
}
