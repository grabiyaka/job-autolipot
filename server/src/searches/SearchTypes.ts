/**
 * Contract between the search runner and a site module. A module knows nothing about users or the database:
 * it turns a query into result pages and, optionally, loads a full description.
 */

/** One search as the site understands it; filtering by CV happens later, at the scoring stage. */
export type SearchQuery = Readonly<{
  keywords: string;
  location?: string;
}>;

/** A job as seen in search results. Field names match `JobInput` of the jobs domain. */
export type JobCard = Readonly<{
  url: string;
  title: string;
  company: string;
  externalId?: string;
  location?: string;
  postedAt?: Date;
  description?: string;
  /** Source-specific fields kept as JSON. */
  raw?: unknown;
}>;

/** What a job page adds to its card; fields left undefined keep the card's value. */
export type JobDetails = Readonly<{
  description?: string;
  title?: string;
  company?: string;
  location?: string;
  raw?: unknown;
}>;

export type Logger = Readonly<{
  info(message: string): void;
  warn(message: string): void;
}>;

export type HttpClient = Readonly<{
  text(url: string, init?: RequestInit): Promise<string>;
  json<T>(url: string, init?: RequestInit): Promise<T>;
}>;

export type BrowserPage = Readonly<{ url: string; title: string }>;
export type BrowserLink = Readonly<{ href: string; text: string }>;

/**
 * A read-only shared browser tab: it opens pages and reads them, but never clicks, types or submits.
 * The tab may be shared with other tools, so a page can change between calls; `text()` and `links()`
 * fail with BrowserError when that happens instead of mixing two pages.
 */
export interface Browser {
  /** Opens a URL in the tab; `status` is the HTTP status when the browser reports one. */
  open(url: string, signal?: AbortSignal): Promise<BrowserPage & Readonly<{ status: number | null }>>;
  /** The page currently in the tab, or null when nothing is open. */
  currentPage(signal?: AbortSignal): Promise<BrowserPage | null>;
  /** Visible text of the current page. */
  text(signal?: AbortSignal): Promise<Readonly<{ url: string; text: string }>>;
  /** Links of the current page that the browser policy allows to open. */
  links(signal?: AbortSignal): Promise<Readonly<{ url: string; links: BrowserLink[] }>>;
  /** Scrolls down to load more results; `screens` is 1–5. */
  scroll(screens: number, signal?: AbortSignal): Promise<void>;
}

export class BrowserError extends Error {
  override name = 'BrowserError';
}
/** The browser cannot be reached at all (no broker, refused, timeout): the whole run stops. */
export class BrowserUnavailableError extends BrowserError {
  override name = 'BrowserUnavailableError';
}
/** The browser policy refused the request (URL not allow-listed, client not allowed); retrying won't help. */
export class BrowserBlockedError extends BrowserError {
  override name = 'BrowserBlockedError';
}

/**
 * The site refused the session (login wall, captcha, checkpoint): this search stops at once, and the
 * remaining searches on the same source in this run are skipped, because they would hit the same wall.
 */
export class SourceStopError extends Error {
  override name = 'SourceStopError';
}

export type SourceContext = Readonly<{
  http: HttpClient;
  browser: Browser;
  log: Logger;
  signal: AbortSignal;
  /** Waits between page opens inside one result page; rejects when the run stops. */
  pause(ms: number): Promise<void>;
}>;

export interface JobSource {
  /** Stored in `jobs.source` and `searches.source`: 'linkedin', 'remoteok', … */
  readonly id: string;
  readonly title: string;
  readonly limits: Readonly<{
    /** Random pause between result pages, in milliseconds. */
    pageDelayMs: readonly [min: number, max: number];
    maxPagesPerQuery: number;
  }>;

  /** Result pages one by one; the runner stops reading when a page has nothing new. */
  search(context: SourceContext, query: SearchQuery): AsyncIterable<JobCard[]>;
  /** Job page data the result list lacks (description, company, …); called only for new jobs. */
  details?(context: SourceContext, card: JobCard): Promise<JobDetails>;
  /** URL without tracking parameters; the deduplication key. Must be idempotent. */
  canonicalUrl(url: string): string;
}
