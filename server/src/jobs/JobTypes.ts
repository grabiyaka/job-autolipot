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

/** What pipeline stages need from the jobs domain; they act on behalf of the owner. */
export interface JobPipelineApi {
  /** URLs the owner has not seen yet, so the collector loads details only for new jobs. */
  unknownUrls(ownerId: string, urls: readonly string[]): Promise<string[]>;
  /** Saves new cards; a broken card is counted and skipped instead of failing the batch. */
  recordFound(ownerId: string, inputs: readonly JobInput[]): Promise<JobFoundResult>;
}
