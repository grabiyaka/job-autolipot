import type { SearchFieldsInput } from '../src/searches/SearchRules.js';
import type { SearchRunReport, SearchStopReason } from '../src/searches/SearchService.js';
import type { ScoringLine, ScoringReport } from '../src/scoring/ScoringService.js';

/**
 * Shared flags and printing of the collect, score and cycle scripts. Pure: parses already split
 * values and returns lines, so the scripts stay thin and this can be tested without a run.
 */

// ── Flags ──

export const collectOptions = {
  user: { type: 'string' }, source: { type: 'string' }, query: { type: 'string' }, location: { type: 'string' },
  include: { type: 'string' }, exclude: { type: 'string' },
  'dry-run': { type: 'boolean' }, 'max-minutes': { type: 'string', default: '60' }, help: { type: 'boolean' },
} as const;

export const scoreOptions = {
  user: { type: 'string' }, limit: { type: 'string' }, 'dry-run': { type: 'boolean' }, model: { type: 'string' },
  threshold: { type: 'string' }, 'no-push': { type: 'boolean' }, help: { type: 'boolean' },
} as const;

type Raw = string | undefined;
export type CollectValues = Readonly<{
  user?: Raw; source?: Raw; query?: Raw; location?: Raw; include?: Raw; exclude?: Raw;
}>;
export type ScoreValues = Readonly<{
  limit?: Raw; model?: Raw; threshold?: Raw; 'dry-run'?: boolean | undefined; 'no-push'?: boolean | undefined;
}>;

const words = (value: Raw): string[] | null => value?.split(',').map((word) => word.trim()).filter(Boolean) ?? null;

/** Ad hoc search when any search flag is given; null means "run the saved searches". */
export function adHocSearch(values: CollectValues): SearchFieldsInput | null {
  const adHoc = [values.source, values.query, values.location, values.include, values.exclude].some((value) => value !== undefined);
  if (!adHoc) return null;
  if (!values.user || !values.source || !values.query) {
    throw new Error('Для разового поиска укажите --user, --source и --query.');
  }
  return {
    source: values.source, keywords: values.query, location: values.location ?? null,
    includeTitle: words(values.include), excludeTitle: words(values.exclude),
  };
}

export function maxMinutes(raw: Raw): number {
  const value = Number(raw);
  if (raw === undefined || !Number.isFinite(value) || value <= 0) throw new Error('--max-minutes — положительное число.');
  return value;
}

function integer(name: string, raw: Raw, { min, max }: { min: number; max: number }): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} — целое число от ${min} до ${max}.`);
  return value;
}

export type ScoreSettings = Readonly<{ dryRun: boolean; push: boolean; limit?: number; threshold?: number; model?: string }>;

export function scoreSettings(values: ScoreValues): ScoreSettings {
  const limit = integer('--limit', values.limit, { min: 1, max: 10_000 });
  const threshold = integer('--threshold', values.threshold, { min: 0, max: 100 });
  return {
    dryRun: values['dry-run'] ?? false,
    push: !(values['no-push'] ?? false),
    ...(limit !== undefined ? { limit } : {}),
    ...(threshold !== undefined ? { threshold } : {}),
    ...(values.model ? { model: values.model } : {}),
  };
}

// ── Collection report ──

export const stopReasons: Record<SearchStopReason, string> = {
  end: 'выдача закончилась',
  known: 'дальше уже известные вакансии',
  limit: 'достигнут предел страниц источника',
  aborted: 'остановлен (Ctrl+C или --max-minutes)',
  error: 'ошибка',
};

export function searchReportLines(report: SearchRunReport, dryRun: boolean): string[] {
  const saved = dryRun ? 'не записано (--dry-run)' : `записано ${report.created}, дублей ${report.duplicates}`;
  return [
    `${report.source} «${report.query.keywords}»${report.query.location ? ` (${report.query.location})` : ''}`,
    `  страниц ${report.pages}, карточек ${report.seen}, новых ${report.fresh}, `
      + `из них отсеяно по названию ${report.filtered}; ${saved}, некорректных ${report.invalid}`,
    `  остановка: ${stopReasons[report.stopped]}${report.error ? ` — ${report.error}` : ''}`,
  ];
}

// ── Scoring report ──

const jobName = (line: { title: string; company: string }) => `${line.title} — ${line.company}`;

export function scoringLine(line: ScoringLine): string {
  switch (line.outcome) {
    case 'queued': return `+ ${line.score} ${jobName(line)}: ${line.why}`;
    case 'rejected': return `− ${line.score} ${jobName(line)}: ${line.why}`;
    case 'skipped': return `= повтор ${jobName(line)} ← ${jobName(line.twin)} (${line.twin.id})`;
    case 'changed': return `~ статус сменился ${jobName(line)}: оставлена как есть`;
    case 'error': return `! ошибка ${jobName(line)}: ${line.message}`;
  }
}

/** "Not linked" is an expected skip; any other profile failure is printed as is. */
export const profileSkip = (report: ScoringReport): string =>
  report.error?.code === 'TRACKER_NOT_LINKED' ? 'не привязан к Job-Tracker' : report.error?.message ?? 'профиль недоступен';

export function scoringSummaryLines(report: ScoringReport, push: boolean): string[] {
  const { counts } = report;
  const profile = report.profile ? `профиль rev ${report.profile.revision}${report.profile.fromCache ? ' (из кеша: Job-Tracker недоступен)' : ''}` : 'профиля нет';
  const speed = report.secondsPerJob === null ? '' : `; ~${report.secondsPerJob} с на вакансию, токены ${report.promptTokens}/${report.evalTokens}`;
  const changed = counts.changed ? `, статус сменился ${counts.changed}` : '';
  const lines = [
    `  модель ${report.model}, ${profile}, порог ${report.threshold}`,
    `  queued ${counts.queued}, rejected ${counts.rejected}, skipped ${counts.skipped}, ошибок ${counts.errors}${changed}${speed}`,
  ];
  if (report.stopped === 'aborted') lines.push('  остановлен по Ctrl+C или по времени');
  if (report.stopped === 'model_unavailable') lines.push(`  остановлен: модель недоступна — ${report.error?.message}`);
  if (report.dryRun) return [...lines, '  не записано (--dry-run), в Job-Tracker не отправлено'];
  if (!push) return [...lines, '  Job-Tracker: не отправлялось (--no-push)'];
  const sent = report.push;
  if (!sent) return lines;
  const invalid = sent.invalid.length ? `, отклонено JT ${sent.invalid.length}` : '';
  const result = `отправлено ${sent.created}, повторы ${sent.duplicates}, уже подавался ${sent.alreadyApplied}, `
    + `дослано оценок ${sent.backfilled}${invalid}, осталось ${sent.remaining}`;
  return [...lines, `  Job-Tracker: ${sent.error ? `ошибка — ${sent.error}; ${result}` : result}`];
}

// ── Cycle summary ──

/** A stage that did not run says why (a flag, a missing broker or Job-Tracker settings). */
export type CycleStage<T> = Readonly<{ ran: true; result: T }> | Readonly<{ ran: false; reason: string }>;
export type CycleCollect = Readonly<{ reports: readonly SearchRunReport[]; dryRun: boolean }>;
export type CycleScore = Readonly<{
  reports: readonly ScoringReport[];
  /** Owners whose profile could not be had, with the reason. */
  skippedOwners: readonly Readonly<{ email: string; reason: string }>[];
  dryRun: boolean;
  push: boolean;
}>;

const sum = <T>(items: readonly T[], value: (item: T) => number) => items.reduce((total, item) => total + value(item), 0);

function collectSummary(stage: CycleStage<CycleCollect>): string {
  if (!stage.ran) return `сбор: пропущен — ${stage.reason}`;
  const { reports, dryRun } = stage.result;
  if (!reports.length) return 'сбор: включённых сохранённых поисков нет';
  const stops = new Map<SearchStopReason, number>();
  for (const report of reports) stops.set(report.stopped, (stops.get(report.stopped) ?? 0) + 1);
  const stopped = [...stops].map(([reason, count]) => `${stopReasons[reason]} ×${count}`).join(', ');
  const saved = dryRun ? 'не записано (--dry-run)' : `записано ${sum(reports, (report) => report.created)}`;
  return `сбор: поисков ${reports.length}, новых ${sum(reports, (report) => report.fresh)}, `
    + `отсеяно по названию ${sum(reports, (report) => report.filtered)}, ${saved}; остановка: ${stopped}`;
}

function scoreSummary(stage: CycleStage<CycleScore>): string[] {
  if (!stage.ran) return [`отбор: пропущен — ${stage.reason}`];
  const { reports, skippedOwners } = stage.result;
  const count = (key: keyof ScoringReport['counts']) => sum(reports, (report) => report.counts[key]);
  const skipped = skippedOwners.length
    ? `; пользователей пропущено ${skippedOwners.length} (${skippedOwners.map((owner) => `${owner.email}: ${owner.reason}`).join('; ')})`
    : '';
  const unavailable = reports.find((report) => report.stopped === 'model_unavailable');
  const aborted = reports.some((report) => report.stopped === 'aborted');
  const stop = unavailable ? `; остановлен: модель недоступна — ${unavailable.error?.message}` : aborted ? '; остановлен по Ctrl+C или по времени' : '';
  return [`отбор: queued ${count('queued')}, rejected ${count('rejected')}, skipped ${count('skipped')}, `
    + `ошибок ${count('errors')}${skipped}${stop}`];
}

function trackerSummary(stage: CycleStage<CycleScore>): string {
  if (!stage.ran) return 'Job-Tracker: не отправлялось (отбора не было)';
  const { reports, dryRun, push } = stage.result;
  if (dryRun) return 'Job-Tracker: не отправлялось (--dry-run)';
  if (!push) return 'Job-Tracker: не отправлялось (--no-push)';
  const sent = reports.flatMap((report) => (report.push ? [report.push] : []));
  if (!sent.length) return 'Job-Tracker: не отправлялось (отбор остановлен до отправки)';
  const errors = sent.flatMap((report) => (report.error ? [report.error] : []));
  const invalid = sum(sent, (report) => report.invalid.length);
  return `Job-Tracker: отправлено ${sum(sent, (report) => report.created)}, повторы ${sum(sent, (report) => report.duplicates)}, `
    + `уже подавался ${sum(sent, (report) => report.alreadyApplied)}, дослано оценок ${sum(sent, (report) => report.backfilled)}, `
    + `отклонено JT ${invalid}, осталось ${sum(sent, (report) => report.remaining)}`
    + (errors.length ? `; ошибки: ${errors.join('; ')}` : '');
}

export function cycleSummaryLines(collect: CycleStage<CycleCollect>, score: CycleStage<CycleScore>): string[] {
  return ['Итог цикла:', ...[collectSummary(collect), ...scoreSummary(score), trackerSummary(score)].map((line) => `  ${line}`)];
}
