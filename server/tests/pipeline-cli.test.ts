import { describe, expect, it } from 'vitest';
import { adHocSearch, cycleSummaryLines, maxMinutes, scoreSettings } from '../scripts/pipeline-cli.js';
import type { ScoringReport } from '../src/scoring/ScoringService.js';
import type { SearchRunReport } from '../src/searches/SearchService.js';

const search = (overrides: Partial<SearchRunReport> = {}): SearchRunReport => ({
  searchId: 's1', ownerId: 'u1', source: 'linkedin', query: { keywords: 'node' },
  pages: 2, seen: 40, fresh: 10, filtered: 3, created: 10, duplicates: 0, invalid: 0, stopped: 'known', ...overrides,
});

const scoring = (overrides: Partial<ScoringReport> = {}): ScoringReport => ({
  model: 'qwen', threshold: 70, dryRun: false, profile: { revision: 3, fromCache: false },
  counts: { queued: 2, rejected: 5, skipped: 1, changed: 0, errors: 0 },
  scored: 7, modelMs: 7000, secondsPerJob: 1, promptTokens: 1, evalTokens: 1,
  stopped: 'end', error: null, lines: [],
  push: { created: 2, backfilled: 1, duplicates: 0, alreadyApplied: 0, invalid: [], unevaluated: [], remaining: 0, error: null },
  ...overrides,
});

describe('cycle flags', () => {
  it('runs saved searches without search flags', () => {
    expect(adHocSearch({ user: 'me@example.com' })).toBeNull();
  });

  it('builds an ad hoc search with title words', () => {
    expect(adHocSearch({ user: 'me@example.com', source: 'linkedin', query: 'node', include: 'node, ts,', exclude: 'java' }))
      .toEqual({ source: 'linkedin', keywords: 'node', location: null, includeTitle: ['node', 'ts'], excludeTitle: ['java'] });
  });

  it('--easy-apply narrows an ad hoc search and alone does not make one', () => {
    expect(adHocSearch({ user: 'me@example.com', source: 'linkedin', query: 'node', 'easy-apply': true }))
      .toMatchObject({ source: 'linkedin', keywords: 'node', easyApplyOnly: true });
    expect(adHocSearch({ user: 'me@example.com', 'easy-apply': true })).toBeNull();
  });

  it('asks for user, source and query once any search flag is given', () => {
    expect(() => adHocSearch({ location: 'Remote' })).toThrow('--user, --source и --query');
    expect(() => adHocSearch({ user: 'me@example.com', query: 'node' })).toThrow('--source');
  });

  it('validates --max-minutes', () => {
    expect(maxMinutes('90')).toBe(90);
    expect(() => maxMinutes('0')).toThrow('--max-minutes');
    expect(() => maxMinutes('abc')).toThrow('--max-minutes');
  });

  it('reads scoring settings and leaves unset tuning out', () => {
    expect(scoreSettings({})).toEqual({ dryRun: false, push: true });
    expect(scoreSettings({ 'dry-run': true, 'no-push': true, limit: '5', threshold: '0', model: 'qwen3' }))
      .toEqual({ dryRun: true, push: false, limit: 5, threshold: 0, model: 'qwen3' });
    expect(() => scoreSettings({ threshold: '101' })).toThrow('--threshold');
    expect(() => scoreSettings({ limit: '1.5' })).toThrow('--limit');
  });
});

describe('cycle summary', () => {
  it('adds up every stage', () => {
    const lines = cycleSummaryLines(
      { ran: true, result: { dryRun: false, reports: [search(), search({ fresh: 4, filtered: 1, created: 4, stopped: 'error', error: 'x' })] } },
      { ran: true, result: { dryRun: false, push: true, reports: [scoring(), scoring()], skippedOwners: [{ email: 'b@x', reason: 'не привязан к Job-Tracker' }] } },
    );
    expect(lines).toEqual([
      'Итог цикла:',
      '  сбор: поисков 2, новых 14, отсеяно по названию 4, записано 14; остановка: дальше уже известные вакансии ×1, ошибка ×1',
      '  отбор: queued 4, rejected 10, skipped 2, ошибок 0; пользователей пропущено 1 (b@x: не привязан к Job-Tracker)',
      '  Job-Tracker: отправлено 4, повторы 0, уже подавался 0, дослано оценок 2, отклонено JT 0, осталось 0',
    ]);
  });

  it('says why a stage did not run', () => {
    const lines = cycleSummaryLines(
      { ran: false, reason: 'брокер браузера недоступен — no socket' },
      { ran: false, reason: 'Job-Tracker не настроен' },
    );
    expect(lines.slice(1)).toEqual([
      '  сбор: пропущен — брокер браузера недоступен — no socket',
      '  отбор: пропущен — Job-Tracker не настроен',
      '  Job-Tracker: не отправлялось (отбора не было)',
    ]);
  });

  it('reports a dry run, a model failure and push errors', () => {
    const dry = cycleSummaryLines(
      { ran: true, result: { dryRun: true, reports: [] } },
      { ran: true, result: { dryRun: true, push: true, reports: [scoring({ push: null })], skippedOwners: [] } },
    );
    expect(dry[1]).toBe('  сбор: включённых сохранённых поисков нет');
    expect(dry[3]).toBe('  Job-Tracker: не отправлялось (--dry-run)');

    const failed = cycleSummaryLines(
      { ran: false, reason: '--skip-collect' },
      { ran: true, result: { dryRun: false, push: true, skippedOwners: [], reports: [scoring({
        stopped: 'model_unavailable', error: { code: 'MODEL_UNAVAILABLE', message: 'ollama down' },
        push: { created: 0, backfilled: 0, duplicates: 0, alreadyApplied: 0, invalid: [{ jobId: 'j', errors: ['bad'] }], unevaluated: [], remaining: 3, error: 'JT 503' },
      })] } },
    );
    expect(failed[2]).toContain('; остановлен: модель недоступна — ollama down');
    expect(failed[3]).toBe('  Job-Tracker: отправлено 0, повторы 0, уже подавался 0, дослано оценок 0, отклонено JT 1, осталось 3; ошибки: JT 503');
  });
});
