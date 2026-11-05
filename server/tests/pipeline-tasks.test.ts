import { describe, expect, it } from 'vitest';
import { BrowserBusyError } from '../plugins/browser-lock.js';
import { cycleSummaryLines } from '../scripts/pipeline-cli.js';
import { collectJobs, runCycle, scoreOwners } from '../scripts/pipeline-tasks.js';
import type { CollectorPort, CycleInput, PipelineOutput } from '../scripts/pipeline-tasks.js';
import type { ScoringOptions, ScoringReport } from '../src/scoring/ScoringService.js';
import type { SearchRunReport } from '../src/searches/SearchService.js';
import { BrowserUnavailableError } from '../src/searches/SearchTypes.js';

const search = (overrides: Partial<SearchRunReport> = {}): SearchRunReport => ({
  searchId: 's1', ownerId: 'u1', source: 'linkedin', query: { keywords: 'node' },
  pages: 2, seen: 40, fresh: 10, filtered: 3, created: 10, duplicates: 0, invalid: 0, stopped: 'known', ...overrides,
});

const scoring = (overrides: Partial<ScoringReport> = {}): ScoringReport => ({
  model: 'qwen', threshold: 70, dryRun: false, profile: { revision: 3, fromCache: false },
  counts: { queued: 1, rejected: 0, skipped: 0, changed: 0, errors: 0 },
  scored: 1, modelMs: 1000, secondsPerJob: 1, promptTokens: 1, evalTokens: 1,
  stopped: 'end', error: null, lines: [{ outcome: 'queued', jobId: 'j1', title: 'Node', company: 'Acme', score: 90, why: 'fits' }],
  push: { created: 1, backfilled: 0, duplicates: 0, alreadyApplied: 0, invalid: [], unevaluated: [], remaining: 0, error: null },
  ...overrides,
});

function recorder() {
  const lines: string[] = [];
  const out: PipelineOutput = { line: (text) => lines.push(text), warn: (text) => lines.push(`! ${text}`) };
  return { lines, out };
}

const collector = (reports: SearchRunReport[], ping: () => Promise<unknown> = async () => ({})): CollectorPort & { closed: number } => {
  const port = {
    closed: 0,
    searches: { runSaved: async () => reports, runAdHoc: async () => reports[0]! },
    pingBrowser: ping,
    close: async () => { port.closed++; },
  };
  return port;
};

const signal = new AbortController().signal;

function cycleInput(overrides: Partial<CycleInput> = {}): CycleInput {
  return {
    owner: { id: 'u1', email: 'me@example.test' }, adHoc: null, skipCollect: false, easyApplyOnly: false,
    score: { dryRun: false, push: true }, signal, stopped: () => null, trackerConfigured: true,
    lockBrowser: () => ({ holder: { task: 'cycle', pid: 1, startedAt: '' }, release: () => {} }),
    openCollector: () => collector([search()]),
    scorer: { scoring: { scoreFound: async () => scoring() } },
    activeUsers: async () => [],
    ...overrides,
  };
}

describe('shared pipeline runs print what the CLI printed', () => {
  it('collect: a report per search, the hint without searches, failed on an error', async () => {
    const one = recorder();
    const run = await collectJobs(collector([search(), search({ stopped: 'error', error: 'boom' })]), {
      adHoc: null, signal, dryRun: false, easyApplyOnly: false,
    }, one.out);
    expect(run.failed).toBe(true);
    expect(one.lines).toEqual([
      '\nlinkedin «node»\n  страниц 2, карточек 40, новых 10, из них отсеяно по названию 3; записано 10, дублей 0, некорректных 0\n  остановка: дальше уже известные вакансии',
      '\nlinkedin «node»\n  страниц 2, карточек 40, новых 10, из них отсеяно по названию 3; записано 10, дублей 0, некорректных 0\n  остановка: ошибка — boom',
    ]);
    const none = recorder();
    await collectJobs(collector([]), { adHoc: null, signal, dryRun: false, easyApplyOnly: false }, none.out);
    expect(none.lines[0]).toMatch(/^Включённых сохранённых поисков нет/);
  });

  it('score: lines per owner; a profile skip fails only for a named owner', async () => {
    const { lines, out } = recorder();
    const skipped = scoring({ stopped: 'profile', error: { code: 'TRACKER_NOT_LINKED', message: 'x' }, lines: [] });
    const scorer = {
      scoring: {
        scoreFound: async (ownerId: string, options: ScoringOptions) => {
          if (ownerId === 'a') return skipped;
          const report = scoring();
          for (const line of report.lines) options.onJob?.(line);
          return report;
        },
      },
    };
    const owners = [{ id: 'a', email: 'a@x' }, { id: 'b', email: 'b@x' }];
    const anyone = await scoreOwners(scorer, owners, { dryRun: false, push: true, signal, namedOwner: false, announceEmpty: false }, out);
    expect(anyone.failed).toBe(false);
    expect(lines.slice(0, 4)).toEqual(['\na@x', '  пропущен: не привязан к Job-Tracker', '\nb@x', '  + 90 Node — Acme: fits']);
    expect(anyone.result.skippedOwners).toEqual([{ email: 'a@x', reason: 'не привязан к Job-Tracker' }]);
    const named = await scoreOwners(scorer, [owners[0]!], { dryRun: false, push: true, signal, namedOwner: true, announceEmpty: false }, recorder().out);
    expect(named.failed).toBe(true);
  });

  it('cycle: stages in order and the lock released', async () => {
    const { lines, out } = recorder();
    let released = 0;
    const port = collector([search()]);
    const result = await runCycle(cycleInput({
      lockBrowser: () => ({ holder: { task: 'cycle', pid: 1, startedAt: '' }, release: () => { released++; } }),
      openCollector: () => port,
    }), out);
    expect(result.failed).toBe(false);
    expect(lines[0]).toBe('== Сбор ==');
    expect(lines).toContain('\n== Отбор ==');
    expect(lines.indexOf('\n== Отбор ==')).toBeGreaterThan(1);
    expect(released).toBe(1);
    expect(port.closed).toBe(1);
    expect(cycleSummaryLines(result.collect, result.score)[1]).toBe(
      '  сбор: поисков 1, новых 10, отсеяно по названию 3, записано 10; остановка: дальше уже известные вакансии ×1');
  });

  it('cycle: a busy browser or a missing broker skips collecting, scoring goes on', async () => {
    const busy = recorder();
    const result = await runCycle(cycleInput({
      lockBrowser: () => { throw new BrowserBusyError({ task: 'collect', pid: 7, startedAt: 'T' }); },
    }), busy.out);
    expect(busy.lines[1]).toBe('! браузер занят: collect с T, pid 7: сбор пропущен, отбор идёт по уже найденным.');
    expect(result.collect).toEqual({ ran: false, reason: 'браузер занят: collect с T, pid 7' });
    expect(result.score.ran).toBe(true);

    const down = recorder();
    const noBroker = await runCycle(cycleInput({
      openCollector: () => collector([], async () => { throw new BrowserUnavailableError('нет сокета'); }),
    }), down.out);
    expect(noBroker.collect).toEqual({ ran: false, reason: 'брокер браузера недоступен — нет сокета' });
    expect(noBroker.score.ran).toBe(true);
  });

  it('cycle: without Job-Tracker scoring is skipped and the run fails', async () => {
    const { lines, out } = recorder();
    const result = await runCycle(cycleInput({ trackerConfigured: false, skipCollect: true }), out);
    expect(result.failed).toBe(true);
    expect(result.collect).toEqual({ ran: false, reason: '--skip-collect' });
    expect(lines.at(-1)).toMatch(/^Job-Tracker не настроен/);
  });
});
