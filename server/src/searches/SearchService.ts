import type { Actor } from '../../framework/core/actor.js';
import { ApplicationError } from '../../framework/core/errors.js';
import type { Clock } from '../../framework/core/runtime.js';
import type { JobCollectorApi } from '../jobs/JobTypes.js';
import type { SearchRepository } from './SearchRepository.js';
import { canonicalCards, errorMessage, pageDelay, searchFields, searchQuery, titleRejection } from './SearchRules.js';
import type { SearchFieldsInput, SearchStopReason, TitleFilter } from './SearchRules.js';
import { BrowserUnavailableError, SourceStopError } from './SearchTypes.js';
import type { Browser, HttpClient, JobCard, JobDetails, JobSource, Logger, SearchQuery, SourceContext } from './SearchTypes.js';

export { searchStopReasons } from './SearchRules.js';
export type { SearchStopReason } from './SearchRules.js';

export type Search = Readonly<{
  id: string;
  source: string;
  keywords: string;
  location: string | null;
  /** At least one of these words must be in a job title; empty means any title. */
  includeTitle: string[];
  /** A job whose title has any of these words is rejected before its page is opened. */
  excludeTitle: string[];
  /** Only jobs with LinkedIn Easy Apply. */
  easyApplyOnly: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}>;
/** A saved search together with its owner, as the runner loads it. */
export type OwnedSearch = Search & Readonly<{ ownerId: string }>;

export type SearchInput = SearchFieldsInput & Readonly<{ enabled?: boolean }>;
export type SearchChange = Readonly<{
  keywords?: string; location?: string | null; includeTitle?: readonly string[]; excludeTitle?: readonly string[];
  easyApplyOnly?: boolean; enabled?: boolean;
}>;

export type SearchRunCounts = {
  pages: number;
  /** Cards seen in results after removing repeats inside this run. */
  seen: number;
  /** Cards the owner did not have before the run. */
  fresh: number;
  /** New cards rejected by the title filter; they are saved as `rejected` without opening their page. */
  filtered: number;
  created: number;
  duplicates: number;
  invalid: number;
};

/** A stored run of a saved search. */
export type SearchRun = Readonly<SearchRunCounts & {
  id: string;
  stopped: SearchStopReason;
  error: string | null;
  startedAt: string;
  finishedAt: string;
}>;
export type NewSearchRun = Readonly<SearchRunCounts & {
  searchId: string; stopped: SearchStopReason; error: string | null; startedAt: Date; finishedAt: Date;
}>;

/** What one run of one search did; `searchId` is null for an ad hoc search that is not saved. */
export type SearchRunReport = SearchRunCounts & {
  searchId: string | null;
  ownerId: string;
  source: string;
  query: SearchQuery;
  stopped: SearchStopReason;
  error?: string;
};

/** Technical capabilities of a run; composition supplies real ones, tests supply fakes. */
export type SearchRuntime = Readonly<{
  http: HttpClient;
  browser: Browser;
  log: Logger;
  /** Waits between result pages; rejects when the signal aborts. */
  pause(ms: number, signal: AbortSignal): Promise<void>;
  random(): number;
}>;

export type SearchRunOptions = Readonly<{ signal: AbortSignal; dryRun?: boolean }>;

type RunTask = Readonly<{ searchId: string | null; ownerId: string; source: JobSource; query: SearchQuery; filter: TitleFilter }>;
/**
 * `browserDown`: the browser could not be reached, so the remaining searches are not attempted.
 * `sourceStopped`: the site refused the session, so the remaining searches on this source are skipped.
 */
type TaskResult = Readonly<{ report: SearchRunReport; browserDown: boolean; sourceStopped: boolean }>;

function withPageDetails(card: JobCard, details: JobDetails): JobCard {
  const defined = Object.entries(details).filter(([, value]) => value !== undefined);
  return { ...card, ...Object.fromEntries(defined) };
}

/** Every request of a module stops with the run unless the module passes its own signal. */
function boundHttp(http: HttpClient, signal: AbortSignal): HttpClient {
  return {
    text: (url, init) => http.text(url, { ...init, signal: init?.signal ?? signal }),
    json: (url, init) => http.json(url, { ...init, signal: init?.signal ?? signal }),
  };
}

/** Browser calls of a module stop with the run unless the module passes its own signal. */
function boundBrowser(browser: Browser, signal: AbortSignal): Browser {
  return {
    open: (url, own) => browser.open(url, own ?? signal),
    currentPage: (own) => browser.currentPage(own ?? signal),
    text: (own) => browser.text(own ?? signal),
    links: (own) => browser.links(own ?? signal),
    scroll: (screens, own) => browser.scroll(screens, own ?? signal),
  };
}

export class SearchService {
  constructor(
    private readonly searches: SearchRepository,
    private readonly jobs: JobCollectorApi,
    private readonly registry: readonly JobSource[],
    private readonly runtime: SearchRuntime,
    private readonly clock: Clock,
  ) {}

  // ── Owner's actions over HTTP ──

  sources(): { id: string; title: string }[] {
    return this.registry.map((source) => ({ id: source.id, title: source.title }));
  }

  list(actor: Actor): Promise<Search[]> {
    return this.searches.list(actor.id);
  }

  create(actor: Actor, input: SearchInput): Promise<Search> {
    return this.searches.create(actor.id, { ...searchFields(input, this.registry), enabled: input.enabled ?? true });
  }

  async update(actor: Actor, id: string, change: SearchChange): Promise<Search> {
    const search = await this.owned(actor.id, id);
    const fields = searchFields({
      source: search.source,
      keywords: change.keywords ?? search.keywords,
      location: change.location === undefined ? search.location : change.location,
      includeTitle: change.includeTitle ?? search.includeTitle,
      excludeTitle: change.excludeTitle ?? search.excludeTitle,
      easyApplyOnly: change.easyApplyOnly ?? search.easyApplyOnly,
    }, this.registry);
    const { source: _source, ...changed } = fields;
    const updated = await this.searches.update(actor.id, id, { ...changed, enabled: change.enabled ?? search.enabled });
    if (!updated) throw this.notFound();
    return updated;
  }

  async remove(actor: Actor, id: string): Promise<void> {
    if (!await this.searches.delete(actor.id, id)) throw this.notFound();
  }

  async runs(actor: Actor, id: string, limit = 20): Promise<SearchRun[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new ApplicationError('INVALID_QUERY', 'limit — от 1 до 100.', 400);
    }
    await this.owned(actor.id, id);
    return this.searches.runs(id, limit);
  }

  // ── Collector: runs on behalf of the owners ──

  /**
   * Runs the enabled saved searches (of one owner, or of everyone) one after another and stores
   * each report. A failing site is reported and the rest continue; a dry run stores nothing.
   * `easyApplyOnly` narrows every search of this run to Easy Apply jobs without changing the saved searches.
   */
  async runSaved(options: SearchRunOptions & Readonly<{ ownerId?: string; easyApplyOnly?: boolean }>): Promise<SearchRunReport[]> {
    const reports: SearchRunReport[] = [];
    const stoppedSources = new Map<string, string>();
    for (const search of await this.searches.listEnabled(options.ownerId)) {
      if (options.signal.aborted) break;
      const source = this.registry.find((candidate) => candidate.id === search.source);
      const query = searchQuery({ ...search, easyApplyOnly: search.easyApplyOnly || (options.easyApplyOnly ?? false) });
      const stopReason = stoppedSources.get(search.source);
      if (stopReason !== undefined) {
        reports.push({ ...this.emptyReport({ searchId: search.id, ownerId: search.ownerId, source: search.source, query }), stopped: 'error', error: `пропущен: ${stopReason}` });
        continue;
      }
      if (!source) {
        this.runtime.log.warn(`${search.source} «${search.keywords}»: источник не подключён, поиск пропущен.`);
        reports.push({ ...this.emptyReport({ searchId: search.id, ownerId: search.ownerId, source: search.source, query }), stopped: 'error', error: 'источник не подключён' });
        continue;
      }
      const startedAt = this.clock.now();
      const filter = { includeTitle: search.includeTitle, excludeTitle: search.excludeTitle };
      const { report, browserDown, sourceStopped } = await this.runTask({ searchId: search.id, ownerId: search.ownerId, source, query, filter }, options);
      if (!options.dryRun) {
        const { searchId: _searchId, ownerId: _ownerId, source: _source, query: _query, error, ...counts } = report;
        await this.searches.recordRun({ ...counts, searchId: search.id, error: error ?? null, startedAt, finishedAt: this.clock.now() });
      }
      reports.push(report);
      if (sourceStopped) stoppedSources.set(search.source, report.error ?? 'источник остановлен');
      if (browserDown) {
        this.runtime.log.warn('Браузер недоступен: остальные поиски этого прогона не выполняются.');
        break;
      }
    }
    return reports;
  }

  /** One search that is not saved: for trying a new source module. Nothing is recorded about the run itself. */
  async runAdHoc(ownerId: string, input: SearchFieldsInput, options: SearchRunOptions): Promise<SearchRunReport> {
    const fields = searchFields(input, this.registry);
    const source = this.registry.find((candidate) => candidate.id === fields.source)!;
    const filter = { includeTitle: fields.includeTitle, excludeTitle: fields.excludeTitle };
    return (await this.runTask({ searchId: null, ownerId, source, query: searchQuery(fields), filter }, options)).report;
  }

  private emptyReport(task: Pick<SearchRunReport, 'searchId' | 'ownerId' | 'source' | 'query'>): SearchRunReport {
    return { ...task, pages: 0, seen: 0, fresh: 0, filtered: 0, created: 0, duplicates: 0, invalid: 0, stopped: 'end' };
  }

  private async runTask(task: RunTask, options: SearchRunOptions): Promise<TaskResult> {
    const { source, ownerId, query } = task;
    const { log } = this.runtime;
    const report = this.emptyReport({ searchId: task.searchId, ownerId, source: source.id, query });
    const context: SourceContext = {
      http: boundHttp(this.runtime.http, options.signal),
      browser: boundBrowser(this.runtime.browser, options.signal),
      log,
      signal: options.signal,
      pause: (ms) => this.runtime.pause(ms, options.signal),
    };
    let browserDown = false;
    let sourceStopped = false;
    const seenUrls = new Set<string>();

    try {
      for await (const page of source.search(context, query)) {
        report.pages++;
        const { cards, invalid } = canonicalCards(source, page, seenUrls);
        report.seen += cards.length;
        report.invalid += invalid;

        const unknown = new Set(await this.jobs.unknownUrls(ownerId, cards.map((card) => card.url)));
        const fresh = cards.filter((card) => unknown.has(card.url));
        report.fresh += fresh.length;
        // The title filter runs before details(): a rejected job's page is never opened.
        const rejected = fresh.flatMap((card) => {
          const rejection = titleRejection(card.title, task.filter);
          return rejection ? [{ ...card, rejection }] : [];
        });
        const passed = fresh.filter((card) => !rejected.some((job) => job.url === card.url));
        report.filtered += rejected.length;
        log.info(`${source.id} «${query.keywords}» стр. ${report.pages}: карточек ${cards.length}, новых ${fresh.length}`
          + (rejected.length ? `, отсеяно по названию ${rejected.length}` : ''));

        if (rejected.length) await this.save(task, rejected, report, options);
        if (passed.length) await this.save(task, await this.withDetails(source, context, passed), report, options);

        // A page without new jobs means the rest was seen on earlier runs: the daily run stays cheap.
        if (!fresh.length) { report.stopped = 'known'; break; }
        if (report.pages >= source.limits.maxPagesPerQuery) { report.stopped = 'limit'; break; }
        await this.runtime.pause(pageDelay(source, this.runtime.random()), options.signal);
      }
    } catch (error) {
      if (options.signal.aborted) report.stopped = 'aborted';
      else {
        report.stopped = 'error';
        report.error = errorMessage(error);
        browserDown = error instanceof BrowserUnavailableError;
        sourceStopped = error instanceof SourceStopError;
        log.warn(`${source.id} «${query.keywords}»: ${report.error}`);
      }
    }
    return { report, browserDown, sourceStopped };
  }

  /**
   * A failed job page keeps the card: it is saved if it is complete enough (JobService decides).
   * A refused session or an unreachable browser stops the search instead.
   */
  private async withDetails(source: JobSource, context: SourceContext, cards: JobCard[]): Promise<JobCard[]> {
    if (!source.details) return cards;
    const detailed: JobCard[] = [];
    for (const card of cards) {
      if (card.description) { detailed.push(card); continue; }
      try {
        detailed.push(withPageDetails(card, await source.details(context, card)));
      } catch (error) {
        if (context.signal.aborted || error instanceof SourceStopError || error instanceof BrowserUnavailableError) throw error;
        this.runtime.log.warn(`${source.id}: описание ${card.url} не загружено: ${errorMessage(error)}`);
        detailed.push(card);
      }
    }
    return detailed;
  }

  /** Saves new jobs; cards with `rejection` are saved as rejected. A dry run only prints them. */
  private async save(
    task: RunTask, cards: readonly (JobCard & { rejection?: string })[], report: SearchRunReport, options: SearchRunOptions,
  ): Promise<void> {
    if (options.dryRun) {
      for (const card of cards) {
        this.runtime.log.info(card.rejection
          ? `  − ${card.title} (${card.rejection}) ${card.url}`
          : `  + ${card.title} — ${card.company} ${card.url}`);
      }
      return;
    }
    const result = await this.jobs.recordFound(task.ownerId, cards.map((card) => ({ ...card, source: task.source.id })));
    report.created += result.created;
    report.duplicates += result.duplicates;
    report.invalid += result.invalid;
  }

  private async owned(ownerId: string, id: string): Promise<Search> {
    const search = await this.searches.find(ownerId, id);
    if (!search) throw this.notFound();
    return search;
  }

  private notFound(): ApplicationError {
    return new ApplicationError('SEARCH_NOT_FOUND', 'Поиск не найден.', 404);
  }
}
