export const jobStatuses = [
  'found', 'scored', 'rejected', 'queued', 'applying', 'applied', 'needs_input', 'failed', 'skipped',
] as const;
export type JobStatus = typeof jobStatuses[number];

/**
 * Company and title with case, spacing and punctuation dropped, so «ACME, Inc.» and «acme inc» match:
 * two jobs with the same key are repeats (see JobPipelineApi.findTwin).
 */
export function twinKey(company: string, title: string): string {
  const plain = (text: string) => text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return `${plain(company)}\n${plain(title)}`;
}

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
  /**
   * Set when a pipeline stage already rejected the job (e.g. the collector's title filter): it is saved
   * as `rejected` with this reason in `why`, so later runs know it and a person can still queue it.
   * The company may then be empty, because the job page was never opened.
   */
  rejection?: string | null;
}>;

export type JobFoundResult = Readonly<{ created: number; duplicates: number; invalid: number; jobIds: string[] }>;

/** A job as pipeline stages see it. `trackerId` is the Job-Tracker opportunity ID, null until synced. */
export type PipelineJob = Readonly<{
  id: string;
  url: string;
  source: string;
  externalId: string | null;
  title: string;
  company: string;
  location: string | null;
  description: string | null;
  postedAt: string | null;
  score: number | null;
  why: string | null;
  redFlags: string[];
  status: JobStatus;
  trackerId: string | null;
  profileRevision: number | null;
}>;

/** Scorer's verdict; `profileRevision` is the Job-Tracker profile revision it was scored against. */
export type JobScore = Readonly<{ score: number; why?: string | null; redFlags?: readonly string[]; profileRevision?: number | null }>;

/** Decisions the scorer makes after a score: queue, reject, or skip a repeat. */
export type JobDecision = 'queued' | 'rejected' | 'skipped';

/** What pipeline stages need from the jobs domain; they act on behalf of the owner. */
export interface JobPipelineApi {
  /** URLs the owner has not seen yet, so the collector loads details only for new jobs. */
  unknownUrls(ownerId: string, urls: readonly string[]): Promise<string[]>;
  /** Saves new cards; a broken card is counted and skipped instead of failing the batch. */
  recordFound(ownerId: string, inputs: readonly JobInput[]): Promise<JobFoundResult>;
  /** `found` jobs with a description, oldest first. */
  listForScoring(ownerId: string, limit?: number): Promise<PipelineJob[]>;
  /**
   * Another job with the same company and title (case, spaces and punctuation ignored) that already
   * went past scoring (including one the model rejected, i.e. `rejected` with a score) or was sent to
   * Job-Tracker; null when the job is not a repeat. A job rejected by the title filter has no score
   * and is not a twin.
   */
  findTwin(ownerId: string, company: string, title: string, exceptId: string): Promise<PipelineJob | null>;
  /** Stores the score; the status becomes `scored`. */
  recordScore(ownerId: string, id: string, input: JobScore): Promise<PipelineJob>;
  /** Moves the job to the decision; a given `why` replaces the stored reason. */
  recordDecision(ownerId: string, id: string, status: JobDecision, why?: string): Promise<PipelineJob>;
  /** `queued` jobs not yet sent to Job-Tracker, oldest first. */
  listUnsynced(ownerId: string): Promise<PipelineJob[]>;
  /** Remembers the Job-Tracker opportunity ID; repeating it with the same ID is a no-op. */
  markSynced(ownerId: string, id: string, trackerId: string): Promise<PipelineJob>;
  /** The owner's job linked to this Job-Tracker opportunity; null when there is none. */
  findByTrackerId(ownerId: string, trackerId: string): Promise<PipelineJob | null>;
}

/** The part of the pipeline API the collector uses. */
export type JobCollectorApi = Pick<JobPipelineApi, 'unknownUrls' | 'recordFound'>;
