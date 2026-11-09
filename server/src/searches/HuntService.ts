import { ApplicationError } from '../../framework/core/errors.js';
import type { Clock } from '../../framework/core/runtime.js';
import type { JobCollectorApi } from '../jobs/JobTypes.js';
import { agentSourceId, resolveAgentSite } from './AgentSites.js';
import type { AgentSite } from './AgentSites.js';
import { HuntAgentError } from './HuntContracts.js';
import type { HuntAgent, HuntAgentRequest, HuntTabs } from './HuntContracts.js';
import {
  describedCards, HUNT_DEFAULT_LIMIT, HUNT_MAX_CARDS, huntDetailPrompt, huntDetailSchema, huntDetailTurns, huntListPrompt,
  huntListSchema, huntListTurns, huntSystemPrompt, listedCards, parseDetails, parseListing, tabsToClose,
} from './HuntRules.js';
import type { HuntTab } from './HuntRules.js';
import type { SearchRepository } from './SearchRepository.js';
import { errorMessage, searchFields, searchQuery, titleRejection } from './SearchRules.js';
import type { SearchFieldsInput, TitleFilter } from './SearchRules.js';
import type { SearchRunReport } from './SearchService.js';
import type { JobCard, Logger, SearchQuery } from './SearchTypes.js';

/**
 * The agent collector (task `hunt`): for every enabled `agent` search the browser agent lists the jobs of
 * the site (step 1), the code canonicalizes them, drops off-site URLs and repeats, keeps only jobs the
 * owner does not have and applies the title filter; then the agent copies the descriptions of the new
 * jobs that passed (step 2, a fresh run, at most `limit` jobs). Jobs are recorded through the same jobs
 * API as the collector, so dedupe, twins, scoring and Job-Tracker work as for LinkedIn.
 *
 * Description policy: a job is saved only with its description (scoring needs it). A job left without
 * one — over the limit, closed, unreadable — is not saved, so the next run lists it as new again.
 * Title-filter rejections are saved at once as `rejected`, so they are not listed as new again.
 *
 * A site that shows a captcha, Cloudflare check or login wall stops its search; the other searches on
 * that site in this run are skipped. The cost of the runs is stored with each search run and the daily
 * limit (all owners: one Claude subscription) is checked before every agent run.
 */

export type HuntSettings = Readonly<{
  /** Daily limit in micro-dollars (list price; notional on a subscription). */
  maxMicrosPerDay: number;
  maxCards?: number;
}>;

export type HuntOptions = Readonly<{
  signal: AbortSignal;
  /** Nothing is written; the agent still runs and costs. */
  dryRun?: boolean;
  ownerId?: string;
  /** New jobs per search whose description is fetched (default 10). */
  limit?: number;
}>;

/** One search of a hunt; `source` is the site id (indeed, djinni…), `searchId` null for an ad hoc search. */
export type HuntReport = SearchRunReport & {
  /** The site key of the search (an id or an https address). */
  site: string;
  /** New jobs that came back with a description (saved unless a dry run). */
  described: number;
  costMicros: number;
  durationMs: number;
  /** What the site blocked with (captcha, login wall…), or null. */
  blocked: string | null;
  /** Not run: an earlier search on the same site was blocked, or the daily limit is spent. */
  skipped: boolean;
};

export type HuntResult = Readonly<{ reports: HuntReport[]; spentTodayMicros: number; budgetMicros: number }>;

type HuntTask = Readonly<{ searchId: string | null; ownerId: string; site: AgentSite; query: SearchQuery; filter: TitleFilter }>;
type Budget = { spent: number; readonly limit: number };
/** `unavailable`: no `claude` / MCP — the remaining searches are not attempted. */
type TaskResult = Readonly<{ report: HuntReport; unavailable: boolean }>;

/** Start of the budget day (00:00 UTC), as for applying. */
const dayStart = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

class HuntBlockedError extends Error {}

export class HuntService {
  constructor(
    private readonly searches: SearchRepository,
    private readonly jobs: JobCollectorApi,
    private readonly agent: HuntAgent,
    private readonly tabs: HuntTabs,
    private readonly clock: Clock,
    private readonly log: Logger,
    private readonly settings: HuntSettings,
  ) {}

  /** The enabled agent searches of one owner (or of everyone), one after another; each run is stored unless a dry run. */
  async runSaved(options: HuntOptions): Promise<HuntResult> {
    const budget = await this.budget();
    const reports: HuntReport[] = [];
    const blockedSites = new Map<string, string>();
    const searches = (await this.searches.listEnabled(options.ownerId)).filter((search) => search.source === agentSourceId);
    for (const search of searches) {
      if (options.signal.aborted) break;
      const query = searchQuery({ ...search, easyApplyOnly: false });
      let site: AgentSite;
      try { site = resolveAgentSite(search.site ?? ''); } catch (error) {
        reports.push({ ...this.emptyReport(search.id, search.ownerId, search.site ?? '?', search.site ?? '', query), stopped: 'error', error: errorMessage(error) });
        continue;
      }
      const empty = this.emptyReport(search.id, search.ownerId, site.id, site.key, query);
      const blocked = blockedSites.get(site.id);
      if (blocked !== undefined) {
        reports.push({ ...empty, stopped: 'error', error: `пропущен: ${blocked}`, blocked, skipped: true });
        continue;
      }
      if (budget.spent >= budget.limit) {
        reports.push({ ...empty, stopped: 'error', error: 'дневной лимит затрат исчерпан (HUNT_MAX_USD_PER_DAY)', skipped: true });
        continue;
      }
      const startedAt = this.clock.now();
      const filter = { includeTitle: search.includeTitle, excludeTitle: search.excludeTitle };
      const { report, unavailable } = await this.runTask({ searchId: search.id, ownerId: search.ownerId, site, query, filter }, budget, options);
      if (!options.dryRun) {
        await this.searches.recordRun({
          searchId: search.id, startedAt, finishedAt: this.clock.now(), stopped: report.stopped, error: report.error ?? null,
          pages: report.pages, seen: report.seen, fresh: report.fresh, filtered: report.filtered, created: report.created,
          duplicates: report.duplicates, invalid: report.invalid, described: report.described, costMicros: report.costMicros,
        });
      }
      reports.push(report);
      if (report.blocked !== null) blockedSites.set(site.id, report.blocked);
      if (unavailable) {
        this.log.warn('Агент недоступен: остальные поиски этого прогона не выполняются.');
        break;
      }
    }
    return { reports, spentTodayMicros: budget.spent, budgetMicros: budget.limit };
  }

  /** One agent search that is not saved (`source: agent` with a site); the run itself is not stored. */
  async runAdHoc(ownerId: string, input: SearchFieldsInput, options: HuntOptions): Promise<HuntResult> {
    const fields = searchFields({ ...input, source: agentSourceId }, []);
    const site = resolveAgentSite(fields.site!);
    const budget = await this.budget();
    if (budget.spent >= budget.limit) {
      throw new ApplicationError('HUNT_BUDGET_SPENT', 'Дневной лимит затрат агента исчерпан (HUNT_MAX_USD_PER_DAY).', 409);
    }
    const filter = { includeTitle: fields.includeTitle, excludeTitle: fields.excludeTitle };
    const { report } = await this.runTask({ searchId: null, ownerId, site, query: searchQuery(fields), filter }, budget, options);
    return { reports: [report], spentTodayMicros: budget.spent, budgetMicros: budget.limit };
  }

  private async budget(): Promise<Budget> {
    return { spent: await this.searches.spentSince(dayStart(this.clock.now())), limit: this.settings.maxMicrosPerDay };
  }

  private emptyReport(searchId: string | null, ownerId: string, source: string, site: string, query: SearchQuery): HuntReport {
    return {
      searchId, ownerId, source, site, query, pages: 0, seen: 0, fresh: 0, filtered: 0, created: 0, duplicates: 0, invalid: 0,
      stopped: 'end', described: 0, costMicros: 0, durationMs: 0, blocked: null, skipped: false,
    };
  }

  private async runTask(task: HuntTask, budget: Budget, options: HuntOptions): Promise<TaskResult> {
    const { site, query, ownerId } = task;
    const report = this.emptyReport(task.searchId, ownerId, site.id, site.key, query);
    const started = this.clock.now().getTime();
    const name = `${site.id} «${query.keywords}»`;
    const limit = options.limit ?? HUNT_DEFAULT_LIMIT;
    const tabsBefore = await this.openTabs();
    let unavailable = false;
    const ask = async (request: Omit<HuntAgentRequest, 'systemPrompt' | 'allowedHosts' | 'signal'>): Promise<unknown> => {
      try {
        const result = await this.agent.run({ ...request, systemPrompt: huntSystemPrompt(site), allowedHosts: site.hosts, signal: options.signal });
        report.costMicros += result.costMicros;
        budget.spent += result.costMicros;
        return result.output;
      } catch (error) {
        if (error instanceof HuntAgentError) {
          report.costMicros += error.costMicros;
          budget.spent += error.costMicros;
          unavailable = error.unavailable;
        }
        throw error;
      }
    };

    try {
      // ── 1. The list ──
      this.log.info(`${name}: агент читает выдачу ${site.searchUrls(query)[0]}`);
      const listing = parseListing(await ask({ prompt: huntListPrompt(site, query, this.settings.maxCards ?? HUNT_MAX_CARDS), schema: huntListSchema, maxTurns: huntListTurns }));
      report.pages = 1;
      const { cards, invalid } = listedCards(site, listing.jobs, this.clock.now());
      report.seen = cards.length;
      report.invalid = invalid;
      const unknown = new Set(await this.jobs.unknownUrls(ownerId, cards.map((card) => card.url)));
      const fresh = cards.filter((card) => unknown.has(card.url));
      report.fresh = fresh.length;
      const rejected = fresh.flatMap((card) => {
        const rejection = titleRejection(card.title, task.filter);
        return rejection ? [{ ...card, rejection }] : [];
      });
      const passed = fresh.filter((card) => !rejected.some((job) => job.url === card.url));
      report.filtered = rejected.length;
      this.log.info(`${name}: карточек ${cards.length}, новых ${fresh.length}`
        + `${rejected.length ? `, отсеяно по названию ${rejected.length}` : ''}${invalid ? `, некорректных ссылок ${invalid}` : ''}`);
      if (rejected.length) await this.save(task, rejected, report, options);
      // A blocked list page may still have shown some jobs; their descriptions are not asked for.
      if (!listing.accessible) throw new HuntBlockedError(listing.blockedAt ?? 'страница выдачи закрыта');
      if (!passed.length) {
        report.stopped = fresh.length ? 'end' : 'known';
        return { report, unavailable };
      }

      // ── 2. Descriptions of the new jobs ──
      const wanted = passed.slice(0, limit);
      if (passed.length > wanted.length) report.stopped = 'limit';
      if (options.signal.aborted) { report.stopped = 'aborted'; return { report, unavailable }; }
      if (budget.spent >= budget.limit) {
        report.stopped = 'error';
        report.error = 'дневной лимит затрат исчерпан (HUNT_MAX_USD_PER_DAY): описания не загружены';
        return { report, unavailable };
      }
      this.log.info(`${name}: агент копирует описания ${wanted.length} вакансий`);
      const details = parseDetails(await ask({ prompt: huntDetailPrompt(site, wanted), schema: huntDetailSchema, maxTurns: huntDetailTurns(wanted.length) }));
      const described = describedCards(site, wanted, details.details);
      report.described = described.length;
      if (described.length) await this.save(task, described, report, options);
      if (described.length < wanted.length) {
        this.log.warn(`${name}: без описания ${wanted.length - described.length} — не записаны, следующий прогон спросит снова`);
      }
      if (!details.accessible) throw new HuntBlockedError(details.blockedAt ?? 'страница вакансии закрыта');
    } catch (error) {
      if (options.signal.aborted) report.stopped = 'aborted';
      else {
        report.stopped = 'error';
        if (error instanceof HuntBlockedError) {
          report.blocked = error.message;
          report.error = `нужна капча/вход — ${error.message}`;
        } else report.error = errorMessage(error);
        this.log.warn(`${name}: ${report.error}`);
      }
    } finally {
      if (tabsBefore) await this.closeAgentTabs(tabsBefore, site);
      report.durationMs = this.clock.now().getTime() - started;
    }
    return { report, unavailable };
  }

  /** The tabs before the agent run; null when the browser cannot list them (then nothing is closed). */
  private async openTabs(): Promise<HuntTab[] | null> {
    try { return await this.tabs.list(); } catch (error) {
      this.log.warn(`вкладки браузера не прочитаны (${errorMessage(error)}): вкладки агента останутся открытыми`);
      return null;
    }
  }

  private async closeAgentTabs(before: readonly HuntTab[], site: AgentSite): Promise<void> {
    try {
      const ids = tabsToClose(before, await this.tabs.list(), site.hosts);
      if (ids.length) await this.tabs.close(ids);
    } catch (error) {
      this.log.warn(`вкладки агента не закрыты: ${errorMessage(error)}`);
    }
  }

  /** Saves jobs under the site id; cards with `rejection` are saved as rejected. A dry run only prints them. */
  private async save(task: HuntTask, cards: readonly (JobCard & { rejection?: string })[], report: HuntReport, options: HuntOptions): Promise<void> {
    if (options.dryRun) {
      for (const card of cards) {
        this.log.info(card.rejection
          ? `  − ${card.title} (${card.rejection}) ${card.url}`
          : `  + ${card.title} — ${card.company} ${card.url} (описание ${card.description?.length ?? 0} симв.)`);
      }
      return;
    }
    const result = await this.jobs.recordFound(task.ownerId, cards.map((card) => ({ ...card, source: task.site.id })));
    report.created += result.created;
    report.duplicates += result.duplicates;
    report.invalid += result.invalid;
  }
}
