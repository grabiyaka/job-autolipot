/**
 * Job-Tracker (JT) is a separate app that keeps the candidate profile and the To Apply list.
 * The client below is its AI API (`/api/ai/*`) as this app uses it; plugins/job-tracker.ts implements it.
 */

export type TrackerUser = Readonly<{ id: string; email: string; name: string | null }>;

/** `profile-context`: the prompt-ready markdown and its revision, or "unchanged since that ETag". */
export type TrackerProfileContext =
  | Readonly<{ status: 'modified'; markdown: string; revision: number; etag: string | null }>
  | Readonly<{ status: 'not_modified' }>;

/** A vacancy as JT accepts it into To Apply. */
export type TrackerJobInput = Readonly<{
  jobTitle: string;
  companyName: string;
  vacancyUrl: string;
  jobDescription?: string;
  location?: string;
  source?: string;
  externalId?: string;
  postedAt?: string;
}>;

/** The outcome of one batch item, in the order the items were sent. */
export type TrackerPushResult =
  | Readonly<{ index: number; status: 'created'; jobId: string }>
  | Readonly<{ index: number; status: 'duplicate_opportunity'; jobId: string }>
  | Readonly<{ index: number; status: 'already_applied'; applicationId: string }>
  | Readonly<{ index: number; status: 'invalid'; errors: string[] }>;

export const trackerVerdicts = ['STRONG_FIT', 'GOOD_FIT', 'WEAK_FIT', 'NOT_A_FIT'] as const;
export type TrackerVerdict = typeof trackerVerdicts[number];

export type TrackerEvaluationInput = Readonly<{
  score: number;
  verdict: TrackerVerdict;
  summary: string;
  profileRevision: number;
  evaluatorName: string;
  model?: string;
  redFlags?: readonly string[];
}>;

/** One page of JT's evaluation worklist (`GET /api/ai/jobs`), oldest first. */
export type TrackerJobPage = Readonly<{ ids: string[]; nextCursor: string | null }>;
export type TrackerWorklistQuery = Readonly<{ evaluation: 'none' | 'stale' | 'needed' | 'any'; cursor?: string | null }>;

/** One To Apply row of `GET /api/ai/jobs` with what applying needs. */
export type TrackerToApplyJob = Readonly<{ id: string; title: string; company: string; url: string; source: string | null }>;
export type TrackerToApplyPage = Readonly<{ items: TrackerToApplyJob[]; nextCursor: string | null }>;

/** Body of `POST /api/ai/jobs/:id/application` (strict on JT's side). */
export type TrackerApplicationInput = Readonly<{ appliedAt?: string; channel: string; agentName: string; note?: string }>;

/**
 * `created` (201) and `already_applied` (200) both mean "JT has it as APPLIED".
 * `not_found` (404): the job is no longer in To Apply (converted by hand) — not to be retried.
 * `conflict` (409): ambiguous company or a company + title duplicate; the owner sorts it out in JT.
 */
export type TrackerMarkResult =
  | Readonly<{ status: 'created' | 'already_applied'; applicationId: string }>
  | Readonly<{ status: 'not_found' }>
  | Readonly<{ status: 'conflict'; message: string }>;

/** At most this many vacancies go into one batch request. */
export const trackerBatchLimit = 50;

export interface JobTrackerClient {
  whoami(): Promise<Readonly<{ user: TrackerUser }>>;
  /** Pass the last ETag to get `not_modified` while the profile is unchanged. */
  profileContext(etag?: string | null): Promise<TrackerProfileContext>;
  /** 1–50 items; one bad item fails only itself. */
  pushJobs(items: readonly TrackerJobInput[]): Promise<TrackerPushResult[]>;
  /** A page (up to 100) of the token user's To Apply rows; pass `nextCursor` back for the next one. */
  listJobs(query: TrackerWorklistQuery): Promise<TrackerJobPage>;
  /** Appends an evaluation to a JT opportunity. */
  recordEvaluation(trackerJobId: string, evaluation: TrackerEvaluationInput): Promise<void>;
  /** A page (up to 100) of To Apply rows with title, company and URL, oldest first. */
  listToApply(cursor?: string | null): Promise<TrackerToApplyPage>;
  /** Turns the To Apply row into an APPLIED Application; call only after a real submit. */
  markApplied(trackerJobId: string, input: TrackerApplicationInput): Promise<TrackerMarkResult>;
}

/**
 * `unavailable`: network error, timeout or 5xx — worth retrying later.
 * `unauthorized`: the token is wrong, revoked or lacks a scope (401/403).
 * `rate_limited`: 429. `rejected`: JT refused the request itself (400, 404, …).
 */
export type TrackerErrorKind = 'unavailable' | 'unauthorized' | 'rate_limited' | 'rejected';

/** Messages never contain the token. */
export class TrackerError extends Error {
  override name = 'TrackerError';
  constructor(readonly kind: TrackerErrorKind, message: string, readonly status: number | null = null) {
    super(message);
  }
}

// ── What other domains (scoring) get from this one ──

export type TrackerProfile = Readonly<{
  markdown: string;
  revision: number;
  fetchedAt: Date;
  /** True when JT did not confirm this copy during the call (it was unreachable, or not asked). */
  fromCache: boolean;
}>;

export type TrackerPushReport = {
  /** Created in JT and marked as synced. */
  created: number;
  /** Evaluations sent for jobs created in JT earlier whose evaluation did not get through then. */
  backfilled: number;
  /** Already in JT's To Apply list: skipped here. */
  duplicates: number;
  /** Already applied to in JT: skipped here. */
  alreadyApplied: number;
  /** Refused by JT's validation; the jobs stay queued. */
  invalid: { jobId: string; errors: string[] }[];
  /**
   * Created in JT, but the evaluation could not be sent (JT failed in between). They are still marked
   * as synced, since sending them again would only hit `duplicate_opportunity`; the next run sends
   * their evaluations from JT's worklist.
   */
  unevaluated: string[];
  /** Queued jobs this run did not send (beyond one batch, or after `error`); the next run sends them. */
  remaining: number;
  error: string | null;
};

export type TrackerPushOptions = Readonly<{ model?: string }>;

export interface TrackerApi {
  /** Refreshes the owner's JT profile by ETag; falls back to the stored copy when JT is unreachable. */
  profile(ownerId: string): Promise<TrackerProfile>;
  /**
   * First sends the missing evaluations of jobs JT already has (its `evaluation=none` worklist),
   * then one batch (up to 50) of the owner's queued, not yet synced jobs with their scores.
   * JT allows 60 requests a minute and each created job costs one more for its evaluation, so a run
   * stops after one batch and the next run sends the rest. JT failures end up in the report.
   */
  pushQueued(ownerId: string, options?: TrackerPushOptions): Promise<TrackerPushReport>;
}

/** What applying needs from Job-Tracker: the To Apply list and the "applied" mark. */
export interface TrackerApplyApi {
  /** The owner's whole To Apply list, oldest first (at most 1000 rows). JT failures are thrown as ApplicationError. */
  listToApply(ownerId: string): Promise<TrackerToApplyJob[]>;
  /**
   * Records in JT that the owner applied to this To Apply row (`channel` linkedin_easy_apply).
   * Outages and refusals are thrown as TrackerError, so the caller can retry later.
   */
  markApplied(ownerId: string, trackerJobId: string, details: Readonly<{ appliedAt: Date; note?: string }>): Promise<TrackerMarkResult>;
  /** False when JOB_TRACKER_URL / JOB_TRACKER_TOKEN are not set. */
  readonly configured: boolean;
}
