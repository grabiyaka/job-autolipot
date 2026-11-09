import { BrowserBusyError } from '../plugins/browser-lock.js';
import type { BrowserLock } from '../plugins/browser-lock.js';
import type { ScoringLine, ScoringReport, ScoringService } from '../src/scoring/ScoringService.js';
import type { SearchFieldsInput } from '../src/searches/SearchRules.js';
import type { SearchRunReport, SearchService } from '../src/searches/SearchService.js';
import type { HuntResult, HuntService } from '../src/searches/HuntService.js';
import { BrowserError } from '../src/searches/SearchTypes.js';
import { huntReportLine, profileSkip, scoringLine, scoringSummaryLines, searchReportLines } from './pipeline-cli.js';
import type { CycleCollect, CycleScore, CycleStage, HuntCollect, StopWording } from './pipeline-cli.js';
import { cliStopWording } from './pipeline-cli.js';

/**
 * The collect, score, cycle and hunt runs shared by the CLI scripts and the Telegram bot. They print through
 * `out` (the CLI passes console, the bot its log) and return structured results; the caller decides the
 * exit code or the report. Only the narrow parts of the composition handles are used, so tests pass fakes.
 */

/** Where a run is now, for a caller that shows progress (the bot's /status); the CLI does not listen. */
export type PipelineStep =
  | Readonly<{ kind: 'stage'; stage: 'collect' | 'hunt' | 'score' }>
  | Readonly<{ kind: 'scored'; line: ScoringLine }>;

export type PipelineOutput = Readonly<{ line(text: string): void; warn(text: string): void; step?(step: PipelineStep): void }>;
/** The CLI's output: warnings go to stderr with «! ». */
export const consoleOutput: PipelineOutput = {
  line: (text) => console.log(text),
  warn: (text) => console.warn(`! ${text}`),
};
export type Owner = Readonly<{ id: string; email: string }>;

export type CollectorPort = Readonly<{
  searches: Pick<SearchService, 'runSaved' | 'runAdHoc'>;
  pingBrowser(signal?: AbortSignal): Promise<unknown>;
  close(): Promise<void>;
}>;
export type ScorerPort = Readonly<{ scoring: Pick<ScoringService, 'scoreFound'> }>;

export type CollectInput = Readonly<{
  adHoc: SearchFieldsInput | null;
  ownerId?: string | undefined;
  signal: AbortSignal;
  dryRun: boolean;
  easyApplyOnly: boolean;
}>;

/** Saved searches (or one ad hoc search) with every report printed; `failed` when a search stopped on an error. */
export async function collectJobs(
  collector: CollectorPort, input: CollectInput, out: PipelineOutput, wording: StopWording = cliStopWording,
): Promise<{ reports: SearchRunReport[]; failed: boolean }> {
  out.step?.({ kind: 'stage', stage: 'collect' });
  const reports = input.adHoc
    ? [await collector.searches.runAdHoc(input.ownerId!, input.adHoc, { signal: input.signal, dryRun: input.dryRun })]
    : await collector.searches.runSaved({
      signal: input.signal, dryRun: input.dryRun, easyApplyOnly: input.easyApplyOnly, ...(input.ownerId ? { ownerId: input.ownerId } : {}),
    });
  if (!reports.length) out.line('Включённых сохранённых поисков нет: добавьте их через POST /api/searches или запустите разовый поиск (--help).');
  for (const report of reports) out.line(['', ...searchReportLines(report, input.dryRun, wording)].join('\n'));
  return { reports, failed: reports.some((report) => report.stopped === 'error') };
}

export type ScoreInput = Readonly<{
  dryRun: boolean;
  push: boolean;
  limit?: number;
  threshold?: number;
  model?: string;
  signal: AbortSignal;
  /** True when one owner was asked for by name: a skipped profile then fails the run. */
  namedOwner: boolean;
  /** Print «Активных пользователей нет.» for an empty list (cycle does, score does not). */
  announceEmpty: boolean;
}>;

/** Scores `found` jobs owner by owner; stops after the model becomes unavailable. */
export async function scoreOwners(
  scorer: ScorerPort, owners: readonly Owner[], input: ScoreInput, out: PipelineOutput, wording: StopWording = cliStopWording,
): Promise<{ result: CycleScore; failed: boolean }> {
  const { signal, namedOwner, announceEmpty, dryRun, push, ...tuning } = input;
  const reports: ScoringReport[] = [];
  const skippedOwners: { email: string; reason: string }[] = [];
  let failed = false;
  out.step?.({ kind: 'stage', stage: 'score' });
  if (!owners.length && announceEmpty) out.line('Активных пользователей нет.');
  for (const owner of owners) {
    if (signal.aborted) break;
    out.line(`\n${owner.email}`);
    const report = await scorer.scoring.scoreFound(owner.id, {
      ...tuning, dryRun, push, signal,
      onJob: (line) => { out.line(`  ${scoringLine(line)}`); out.step?.({ kind: 'scored', line }); },
    });
    if (report.stopped === 'profile') {
      const reason = profileSkip(report);
      out.line(`  пропущен: ${reason}`);
      skippedOwners.push({ email: owner.email, reason });
      if (namedOwner) failed = true;
      continue;
    }
    if (!report.lines.length && report.stopped === 'end') out.line('  новых вакансий для оценки нет');
    out.line(scoringSummaryLines(report, push, wording).join('\n'));
    reports.push(report);
    if (report.stopped === 'model_unavailable') { failed = true; break; }
  }
  return { result: { reports, skippedOwners, dryRun, push }, failed };
}

export type CycleInput = Readonly<{
  /** Only this owner; null — every active one. */
  owner: Owner | null;
  adHoc: SearchFieldsInput | null;
  skipCollect: boolean;
  easyApplyOnly: boolean;
  score: Omit<ScoreInput, 'signal' | 'namedOwner' | 'announceEmpty'>;
  signal: AbortSignal;
  /** Why the run was stopped (Ctrl+C, /stop, time limit); null while it goes on. */
  stopped(): string | null;
  trackerConfigured: boolean;
  /** Takes the shared browser lock; throws BrowserBusyError when another task holds it. */
  lockBrowser(): BrowserLock;
  openCollector(): CollectorPort;
  scorer: ScorerPort;
  activeUsers(): Promise<Owner[]>;
}>;

export type CycleResult = Readonly<{ collect: CycleStage<CycleCollect>; score: CycleStage<CycleScore>; failed: boolean }>;

/**
 * Collect → score → send. A busy browser or a missing broker skips collecting and scoring still goes;
 * a stop skips the stages that did not start yet.
 */
export async function runCycle(input: CycleInput, out: PipelineOutput, wording: StopWording = cliStopWording): Promise<CycleResult> {
  const { owner, signal } = input;
  let failed = false;

  // ── 1. Сбор ──
  out.line('== Сбор ==');
  out.step?.({ kind: 'stage', stage: 'collect' });
  let collect: CycleStage<CycleCollect>;
  let lock: BrowserLock | null = null;
  let busy: string | null = null;
  if (!input.skipCollect) {
    try { lock = input.lockBrowser(); } catch (error) {
      if (!(error instanceof BrowserBusyError)) throw error;
      busy = error.message;
    }
  }
  if (input.skipCollect) {
    collect = { ran: false, reason: '--skip-collect' };
  } else if (busy !== null) {
    out.warn(`${busy}: сбор пропущен, отбор идёт по уже найденным.`);
    collect = { ran: false, reason: busy };
  } else {
    try {
      const collector = input.openCollector();
      try {
        let brokerDown: string | null = null;
        try { await collector.pingBrowser(signal); } catch (error) {
          if (!(error instanceof BrowserError)) throw error;
          brokerDown = error.message;
        }
        const interrupted = input.stopped();
        if (interrupted) {
          collect = { ran: false, reason: interrupted };
        } else if (brokerDown !== null) {
          out.warn(`Брокер браузера недоступен (${brokerDown}): сбор пропущен, отбор идёт по уже найденным.`);
          collect = { ran: false, reason: `брокер браузера недоступен — ${brokerDown}` };
        } else {
          const run = await collectJobs(collector, {
            adHoc: input.adHoc, ownerId: owner?.id, signal, dryRun: input.score.dryRun, easyApplyOnly: input.easyApplyOnly,
          }, out, wording);
          if (run.failed) failed = true;
          collect = { ran: true, result: { reports: run.reports, dryRun: input.score.dryRun } };
        }
      } finally {
        await collector.close();
      }
    } finally {
      lock?.release();
    }
  }

  // ── 2. Отбор и 3. отправка в Job-Tracker (внутри scoreFound) ──
  const scored = await scoreStage(input, out, wording);
  return { collect, score: scored.score, failed: failed || scored.failed };
}

type ScoreStageInput = Pick<CycleInput, 'owner' | 'score' | 'signal' | 'stopped' | 'trackerConfigured' | 'scorer' | 'activeUsers'>;

/** Scoring and sending after a collecting stage: skipped after a stop, fails without Job-Tracker. */
async function scoreStage(input: ScoreStageInput, out: PipelineOutput, wording: StopWording): Promise<{ score: CycleStage<CycleScore>; failed: boolean }> {
  out.line('\n== Отбор ==');
  out.step?.({ kind: 'stage', stage: 'score' });
  const stopReason = input.stopped();
  if (stopReason) return { score: { ran: false, reason: stopReason }, failed: false };
  if (!input.trackerConfigured) {
    out.line('Job-Tracker не настроен: задайте JOB_TRACKER_URL и JOB_TRACKER_TOKEN в .env — профиль для оценки берётся оттуда.');
    return { score: { ran: false, reason: 'Job-Tracker не настроен (JOB_TRACKER_URL, JOB_TRACKER_TOKEN)' }, failed: true };
  }
  const owners = input.owner ? [input.owner] : await input.activeUsers();
  const scored = await scoreOwners(input.scorer, owners, {
    ...input.score, signal: input.signal, namedOwner: input.owner !== null, announceEmpty: true,
  }, out, wording);
  return { score: { ran: true, result: scored.result }, failed: scored.failed };
}

export type HunterPort = Readonly<{ hunt: Pick<HuntService, 'runSaved' | 'runAdHoc'>; close(): Promise<void> }>;

export type HuntInput = ScoreStageInput & Readonly<{
  /** An ad hoc agent search (`source: agent` with a site) instead of the saved ones; needs `owner`. */
  adHoc: SearchFieldsInput | null;
  /** Descriptions per search (default 10). */
  limit?: number;
  /** Only the agent stage: no scoring and no sending. */
  skipScore: boolean;
  /** The browser lock is the caller's: it is held for the whole hunt. */
  openHunter(): HunterPort;
}>;

export type HuntRunResult = Readonly<{ hunt: CycleStage<HuntCollect>; score: CycleStage<CycleScore>; failed: boolean }>;

/**
 * Hunt: the browser agent collects from other job boards (saved `agent` searches), then the new `found`
 * jobs are scored and sent like in cycle. The caller holds the browser lock for the whole run.
 */
export async function runHunt(input: HuntInput, out: PipelineOutput, wording: StopWording = cliStopWording): Promise<HuntRunResult> {
  const { owner, signal } = input;
  const dryRun = input.score.dryRun;
  out.line('== Сбор через агента ==');
  out.step?.({ kind: 'stage', stage: 'hunt' });
  const options = { signal, dryRun, ...(input.limit !== undefined ? { limit: input.limit } : {}) };
  const hunter = input.openHunter();
  let result: HuntResult;
  try {
    result = input.adHoc
      ? await hunter.hunt.runAdHoc(owner!.id, input.adHoc, options)
      : await hunter.hunt.runSaved({ ...options, ...(owner ? { ownerId: owner.id } : {}) });
  } finally {
    await hunter.close();
  }
  if (!result.reports.length) out.line('Включённых поисков через агента нет: добавьте их (/search @indeed node.js | Ireland) или запустите разовый (--help).');
  for (const report of result.reports) out.line(huntReportLine(report, dryRun, wording));
  const hunt: CycleStage<HuntCollect> = { ran: true, result: { ...result, dryRun } };
  const huntFailed = result.reports.some((report) => report.stopped === 'error');
  if (input.skipScore) return { hunt, score: { ran: false, reason: '--skip-score' }, failed: huntFailed };
  const scored = await scoreStage(input, out, wording);
  return { hunt, score: scored.score, failed: huntFailed || scored.failed };
}
