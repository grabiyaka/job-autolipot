import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '../generated/prisma/client.js';
import { acquireBrowserLock } from '../plugins/browser-lock.js';
import { cronCalendar } from '../plugins/cron.js';
import { createPrismaClient } from '../plugins/database.js';
import type { InlineKeyboard, TelegramClient, TelegramUpdate } from '../plugins/telegram.js';
import { parseCallback, parseCommand, parseOptions } from '../scripts/bot-commands.js';
import { Scheduler, shouldReport, TelegramBot } from '../scripts/bot-runtime.js';
import type { BotOwner, BotServices, TaskOutcome, Timer } from '../scripts/bot-runtime.js';
import type { PipelineOutput } from '../scripts/pipeline-tasks.js';
import type { Answer } from '../src/answers/AnswerTypes.js';
import type { JobStatus } from '../src/jobs/JobTypes.js';
import { ScheduleRepository } from '../src/schedules/ScheduleRepository.js';
import { ScheduleService } from '../src/schedules/ScheduleService.js';
import type { Schedule } from '../src/schedules/ScheduleService.js';
import type { ScoringOptions, ScoringReport } from '../src/scoring/ScoringService.js';
import type { Search, SearchRunReport } from '../src/searches/SearchService.js';
import { createTestDatabase } from './auth-fixture.js';
import { agentAnswer, createTestApplier, FakeAgent, FakeApplyTracker, linkedinUrl } from './apply-fixture.js';

describe('bot commands', () => {
  it('parses runs with flags and refuses unknown flags', () => {
    expect(parseCommand('/run cycle limit=20 max=30 easy')).toEqual({ kind: 'run', task: 'cycle', options: { limit: 20, maxMinutes: 30, easyApply: true } });
    expect(parseCommand('/run@JobAutopilotBot score threshold=75')).toEqual({ kind: 'run', task: 'score', options: { threshold: 75 } });
    expect(parseCommand('/run apply limit=2')).toEqual({ kind: 'run', task: 'apply', options: { limit: 2 } });
    expect(parseCommand('/schedule apply 0 10 * * 1-5 limit=3')).toEqual({ kind: 'schedule', task: 'apply', cron: '0 10 * * 1-5', options: { limit: 3 } });
    expect(parseCommand('/pending')).toEqual({ kind: 'pending' });
    expect(parseCommand('/run')).toMatchObject({ kind: 'invalid' });
    expect(parseCommand('/run cycle dry-run')).toMatchObject({ kind: 'invalid', message: expect.stringMatching(/Неизвестный флаг/) });
    expect(parseOptions(['skip-collect=no', 'limit=5'])).toEqual({ skipCollect: false, limit: 5 });
    expect(parseOptions(['limit=x'])).toMatch(/целое/);
  });

  it('parses schedules, on/off and answers', () => {
    expect(parseCommand('/schedule')).toEqual({ kind: 'schedules' });
    expect(parseCommand('/schedule cycle 0 9,18 * * *')).toEqual({ kind: 'schedule', task: 'cycle', cron: '0 9,18 * * *', options: {} });
    expect(parseCommand('/schedule score 0 7 * * 1-5 limit=50')).toEqual({ kind: 'schedule', task: 'score', cron: '0 7 * * 1-5', options: { limit: 50 } });
    expect(parseCommand('/schedule cycle 0 9')).toMatchObject({ kind: 'invalid', message: expect.stringMatching(/5 полей/) });
    expect(parseCommand('/on cycle')).toEqual({ kind: 'toggle', task: 'cycle', enabled: true });
    expect(parseCommand('/off score')).toEqual({ kind: 'toggle', task: 'score', enabled: false });
    expect(parseCommand('/answer Years of TypeScript? = 1 = one')).toEqual({ kind: 'answer', question: 'Years of TypeScript?', answer: '1 = one' });
    expect(parseCommand('/answer no separator')).toMatchObject({ kind: 'invalid' });
    expect(parseCommand('/whatever')).toMatchObject({ kind: 'invalid' });
    expect(parseCommand('hello')).toBeNull();
    for (const name of ['status', 'stop', 'searches', 'queued', 'answers', 'help', 'start']) expect(parseCommand(`/${name}`)).not.toBeNull();
  });

  it('parses /search: keywords, location, title words, Easy Apply by default', () => {
    expect(parseCommand('/search node.js developer | Remote | +node, typescript | -java,qa')).toEqual({
      kind: 'addSearch',
      search: { source: 'linkedin', keywords: 'node.js developer', location: 'Remote', includeTitle: ['node', 'typescript'], excludeTitle: ['java', 'qa'], easyApplyOnly: true },
    });
    expect(parseCommand('/search backend | −php | all')).toEqual({
      kind: 'addSearch',
      search: { source: 'linkedin', keywords: 'backend', includeTitle: [], excludeTitle: ['php'], easyApplyOnly: false },
    });
    expect(parseCommand('/search')).toMatchObject({ kind: 'invalid', message: expect.stringMatching(/^Формат: \/search/) });
    expect(parseCommand('/search | Remote')).toMatchObject({ kind: 'invalid' });
    expect(parseCommand('/search node | Dublin | Cork')).toMatchObject({ kind: 'invalid', message: expect.stringMatching(/Две локации/) });
  });

  it('parses button data', () => {
    expect(parseCallback('s:off:abc-1')).toEqual({ kind: 'schedule', action: 'off', id: 'abc-1' });
    expect(parseCallback('s:del:abc')).toEqual({ kind: 'schedule', action: 'delete', id: 'abc' });
    expect(parseCallback('q:on:abc')).toEqual({ kind: 'search', action: 'on', id: 'abc' });
    expect(parseCallback('q:del:abc')).toEqual({ kind: 'search', action: 'delete', id: 'abc' });
    expect(parseCallback('a:ok:app-1')).toEqual({ kind: 'application', action: 'submit', id: 'app-1' });
    expect(parseCallback('a:no:app-1')).toEqual({ kind: 'application', action: 'reject', id: 'app-1' });
    expect(parseCallback('a:del:app-1')).toBeNull();
    expect(parseCallback('x')).toBeNull();
    expect(parseCallback(undefined)).toBeNull();
  });
});

describe('scheduled report policy', () => {
  const outcome = (overrides: Partial<TaskOutcome>): TaskOutcome => ({
    task: 'cycle', trigger: 'schedule', status: 'ok', lines: [], queued: 0, problems: false, minutes: 1, ...overrides,
  });
  it('reports a quiet scheduled run only under "always"', () => {
    expect(shouldReport(outcome({}), 'changes')).toBe(false);
    expect(shouldReport(outcome({}), 'always')).toBe(true);
    expect(shouldReport(outcome({ queued: 1 }), 'changes')).toBe(true);
    expect(shouldReport(outcome({ problems: true }), 'changes')).toBe(true);
    expect(shouldReport(outcome({ status: 'busy' }), 'changes')).toBe(true);
    expect(shouldReport(outcome({ status: 'error' }), 'changes')).toBe(true);
    expect(shouldReport(outcome({ trigger: 'manual' }), 'changes')).toBe(true);
  });
});

// ── Fakes ──

type FakeTimer = Timer & { pending: { callback: () => void; ms: number } | null };
function fakeTimer(): FakeTimer {
  const timer: FakeTimer = {
    pending: null,
    set(callback, ms) { timer.pending = { callback, ms }; return timer.pending; },
    clear(handle) { if (timer.pending === handle) timer.pending = null; },
  };
  return timer;
}

type Sent = { method: string; chatId?: number; text?: string; keyboard?: InlineKeyboard; callbackText?: string };
function fakeTelegram() {
  const sent: Sent[] = [];
  const client: TelegramClient = {
    getUpdates: async () => [],
    async sendMessage(chatId, text, options = {}) { sent.push({ method: 'sendMessage', chatId, text, ...(options.keyboard ? { keyboard: options.keyboard } : {}) }); return sent.length; },
    async editMessageText(chatId, _messageId, text, options = {}) { sent.push({ method: 'editMessageText', chatId, text, ...(options.keyboard ? { keyboard: options.keyboard } : {}) }); },
    async answerCallbackQuery(_id, text) { sent.push({ method: 'answerCallbackQuery', ...(text ? { callbackText: text } : {}) }); },
  };
  return { client, sent, texts: () => sent.filter((item) => item.method === 'sendMessage').map((item) => item.text!) };
}

const searchReport = (overrides: Partial<SearchRunReport> = {}): SearchRunReport => ({
  searchId: 's1', ownerId: 'u1', source: 'linkedin', query: { keywords: 'node' },
  pages: 2, seen: 40, fresh: 10, filtered: 3, created: 10, duplicates: 0, invalid: 0, stopped: 'known', ...overrides,
});

const scoringReport = (overrides: Partial<ScoringReport> = {}): ScoringReport => ({
  model: 'qwen', threshold: 70, dryRun: false, profile: { revision: 3, fromCache: false },
  counts: { queued: 2, rejected: 5, skipped: 1, changed: 0, errors: 0 },
  scored: 7, modelMs: 7000, secondsPerJob: 1, promptTokens: 1, evalTokens: 1,
  stopped: 'end', error: null, lines: [],
  push: { created: 2, backfilled: 1, duplicates: 0, alreadyApplied: 0, invalid: [], unevaluated: [], remaining: 0, error: null },
  ...overrides,
});

/** A promise the test resolves by hand, to keep a task running. */
function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}

const chatId = 4242;
const quiet: PipelineOutput = { line: () => {}, warn: () => {} };

describe('Telegram bot on fake Telegram and fake pipeline', () => {
  let testDatabase: ReturnType<typeof createTestDatabase>;
  let database: PrismaClient;
  let owner: BotOwner;
  let lockDirectory: string;
  let lockPath: string;
  let now: Date;
  let timer: FakeTimer;
  let telegram: ReturnType<typeof fakeTelegram>;
  let bot: TelegramBot;
  let schedules: ScheduleService;
  // What the fake pipeline does and saw.
  let collectGate: ReturnType<typeof gate> | null;
  let collectSignals: AbortSignal[];
  let scoreCalls: { ownerId: string; options: ScoringOptions }[];
  let searches: Search[];
  let answers: Answer[];
  let trackerConfigured: boolean;
  let applyTracker: FakeApplyTracker;
  let applyAgent: FakeAgent;

  beforeAll(async () => {
    testDatabase = createTestDatabase();
    database = createPrismaClient(testDatabase.url);
    const user = await database.user.create({ data: { email: 'owner@example.test', name: 'Owner', passwordHash: 'x' } });
    owner = { id: user.id, role: 'user', email: user.email };
    lockDirectory = mkdtempSync(path.join(tmpdir(), 'bot-lock-'));
    lockPath = path.join(lockDirectory, 'browser.lock');
  }, 60_000);

  afterAll(async () => {
    await database?.$disconnect();
    testDatabase?.dispose();
    rmSync(lockDirectory, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await database.taskRun.deleteMany({});
    await database.schedule.deleteMany({});
    await database.job.deleteMany({});
    await database.answer.deleteMany({});
    rmSync(lockPath, { force: true });
    now = new Date('2026-11-04T10:00:00Z');
    timer = fakeTimer();
    telegram = fakeTelegram();
    collectGate = null;
    collectSignals = [];
    scoreCalls = [];
    trackerConfigured = true;
    searches = [{
      id: 'search-1', source: 'linkedin', keywords: 'node.js', location: 'Ireland', includeTitle: [], excludeTitle: ['java'],
      easyApplyOnly: true, enabled: true, createdAt: '', updatedAt: '',
    }];
    answers = [];
    schedules = new ScheduleService(new ScheduleRepository(database), cronCalendar, { now: () => now }, { timezone: 'Europe/Dublin' });

    applyTracker = new FakeApplyTracker();
    applyAgent = new FakeAgent();
    const applier = createTestApplier(database, { tracker: applyTracker, agent: applyAgent, lockPath, now: () => now });
    const counts = { found: 3, scored: 0, rejected: 5, queued: 2, applying: 0, applied: 0, needs_input: 0, failed: 0, skipped: 1 } as Record<JobStatus, number>;
    const services: BotServices = {
      jobs: {
        summary: async () => ({ total: 11, counts }),
        list: async (_actor, query = {}) => ({
          items: query.status === 'queued' ? [
            { id: 'j1', score: 88, title: 'Node <Engineer>', company: 'Acme', url: 'https://www.linkedin.com/jobs/view/1/' },
            { id: 'j2', score: 77, title: 'Backend', company: 'Beta', url: 'https://www.linkedin.com/jobs/view/2/' },
          ] as never : [],
          total: 2, page: 1, limit: query.limit ?? 20,
        }),
      },
      searches: {
        list: async () => searches,
        create: async (_actor, input) => {
          const created: Search = {
            id: `search-${searches.length + 1}`, source: input.source, keywords: input.keywords, location: input.location ?? null,
            includeTitle: [...input.includeTitle ?? []], excludeTitle: [...input.excludeTitle ?? []],
            easyApplyOnly: input.easyApplyOnly ?? false, enabled: true, createdAt: '', updatedAt: '',
          };
          searches = [...searches, created];
          return created;
        },
        update: async (_actor, id, change) => {
          searches = searches.map((search) => (search.id === id ? { ...search, enabled: change.enabled ?? search.enabled } : search));
          return searches.find((search) => search.id === id)!;
        },
        remove: async (_actor, id) => { searches = searches.filter((search) => search.id !== id); },
      },
      answers: {
        list: async () => answers,
        upsert: async (_ownerId, question, answer, origin) => {
          const saved: Answer = { id: `a${answers.length + 1}`, question, answer, origin, createdAt: '', updatedAt: '' };
          answers = [...answers, saved];
          return saved;
        },
      },
      schedules,
      applications: applier.applications,
      pipeline: {
        get trackerConfigured() { return trackerConfigured; },
        lockBrowser: (task) => acquireBrowserLock({ task: `bot:${task}`, path: lockPath }),
        openCollector: () => ({
          searches: {
            runSaved: async (options) => {
              collectSignals.push(options.signal);
              if (collectGate) await collectGate.promise;
              return [searchReport({ ownerId: options.ownerId!, stopped: options.signal.aborted ? 'aborted' : 'known' })];
            },
            runAdHoc: async () => { throw new Error('not used'); },
          },
          pingBrowser: async () => ({}),
          close: async () => {},
        }),
        openScorer: () => ({
          scoring: {
            scoreFound: async (ownerId, options) => { scoreCalls.push({ ownerId, options }); return scoringReport(); },
          },
          close: async () => {},
        }),
      },
    };
    bot = new TelegramBot(telegram.client, owner, services, { chatId, timezone: 'Europe/Dublin', reportPolicy: 'changes' }, {
      now: () => now, timer, out: quiet,
    });
  });

  let updateId = 0;
  const message = (text: string, chat = chatId): TelegramUpdate => ({
    update_id: ++updateId, message: { message_id: updateId, chat: { id: chat }, date: Math.floor(now.getTime() / 1000), text },
  });
  const say = (text: string, chat = chatId) => bot.handleUpdate(message(text, chat));

  it('stays silent to another chat', async () => {
    await say('/run cycle', 1);
    await say('/status', 1);
    await bot.handleUpdate({ update_id: 99, callback_query: { id: 'q', data: 's:off:x', message: { message_id: 1, chat: { id: 1 } } } });
    await bot.settled();
    expect(telegram.sent).toEqual([]);
    expect(scoreCalls).toEqual([]);
    expect(await schedules.recentRuns(owner)).toEqual([]);
  });

  it('ignores commands sent long before it started', async () => {
    await bot.handleUpdate({ update_id: 1, message: { message_id: 1, chat: { id: chatId }, date: Math.floor(now.getTime() / 1000) - 3600, text: '/run cycle' } });
    await bot.settled();
    expect(telegram.sent).toEqual([]);
  });

  it('/run cycle collects and scores for the owner and reports with the best queued', async () => {
    await say('/run cycle limit=5');
    expect(telegram.texts()[0]).toMatch(/Запускаю <b>cycle<\/b>/);
    await bot.settled();

    expect(collectSignals).toHaveLength(1);
    expect(scoreCalls).toEqual([{ ownerId: owner.id, options: expect.objectContaining({ limit: 5, dryRun: false, push: true }) }]);
    const report = telegram.texts()[1]!;
    expect(report).toMatch(/^✅ <b>cycle<\/b> вручную/);
    expect(report).toContain('Итог цикла:');
    expect(report).toContain('отбор: queued 2, rejected 5');
    expect(report).toContain('Job-Tracker: отправлено 2');
    expect(report).toContain('Новых в queued: 2');
    expect(report).toContain('Node &lt;Engineer&gt; — Acme');
    expect(report).toContain('https://www.linkedin.com/jobs/view/1/');
    const [run] = await schedules.recentRuns(owner);
    expect(run).toMatchObject({ task: 'cycle', trigger: 'manual', status: 'ok', summary: expect.stringContaining('Итог цикла:') });
  });

  it('answers «занято» while a task runs, and /stop stops it', async () => {
    collectGate = gate();
    await say('/run collect');
    await new Promise((resolve) => setImmediate(resolve));
    now = new Date('2026-11-04T10:03:00Z');
    await say('/run score');
    expect(telegram.texts()[1]).toMatch(/⛔ <b>score<\/b> вручную\nзанято: collect, запущено 3 мин назад/);
    expect(scoreCalls).toEqual([]);

    await say('/status');
    expect(telegram.texts()[2]).toContain('<b>Сейчас</b>: занято: collect, запущено 3 мин назад');

    await say('/stop');
    expect(telegram.texts()[3]).toMatch(/Останавливаю <b>collect<\/b>/);
    expect(collectSignals[0]!.aborted).toBe(true);
    collectGate.open();
    await bot.settled();
    expect(telegram.texts()[4]).toMatch(/^⏹ <b>collect<\/b> вручную/);
    expect(telegram.texts()[4]).toContain('остановлен (/stop или предел времени)');
    const runs = await schedules.recentRuns(owner);
    expect(runs.map((run) => [run.task, run.status])).toEqual([['score', 'busy'], ['collect', 'aborted']]);

    await say('/stop');
    expect(telegram.texts()[5]).toBe('Сейчас ничего не выполняется.');
  });

  it('sees the browser lock of a CLI run', async () => {
    writeFileSync(lockPath, JSON.stringify({ task: 'collect', pid: process.pid, startedAt: '2026-11-04T09:50:00.000Z' }));
    await say('/run collect');
    await bot.settled();
    expect(telegram.texts().at(-1)).toMatch(/занято: браузер — collect \(pid \d+\), запущено 10 мин назад/);
    expect(collectSignals).toEqual([]);

    // A cycle skips collecting and still scores, as `npm run cycle` does.
    await say('/run cycle');
    await bot.settled();
    expect(collectSignals).toEqual([]);
    expect(scoreCalls).toHaveLength(1);
    expect(telegram.texts().at(-1)).toContain('сбор: пропущен — браузер занят: collect');
  });

  it('reports an error when Job-Tracker is not configured', async () => {
    trackerConfigured = false;
    await say('/run score');
    await bot.settled();
    expect(telegram.texts().at(-1)).toMatch(/^⚠️ <b>score<\/b>/);
    expect((await schedules.recentRuns(owner))[0]).toMatchObject({ status: 'error' });
  });

  it('creates a schedule switched off, turns it on and off, and plans the timer', async () => {
    await say('/schedule cycle 0 9,18 * * *');
    expect(telegram.texts()[0]).toMatch(/^Создано: <b>cycle<\/b> <code>0 9,18 \* \* \*<\/code> Europe\/Dublin — выкл/);
    expect(telegram.texts()[0]).toContain('включить: /on cycle');
    expect(timer.pending).toBeNull();

    await say('/on cycle');
    expect(telegram.texts()[1]).toMatch(/^Включено: .*следующий 04\.11 18:00/);
    expect(timer.pending?.ms).toBe(60 * 60_000); // capped at an hour; 18:00 is eight hours away
    expect(bot.scheduler.nextAt).toEqual(new Date('2026-11-04T18:00:00Z'));

    await say('/schedule cycle 30 7 * * *');
    expect(telegram.texts()[2]).toMatch(/^Заменено: .*вкл/);
    expect(telegram.texts()[2]).toContain('выключить: /off cycle');

    await say('/off cycle');
    expect(timer.pending).toBeNull();
    await say('/on nothing');
    expect(telegram.texts().at(-1)).toMatch(/Неизвестная задача/);
    await say('/off score');
    expect(telegram.texts().at(-1)).toMatch(/Расписания для score нет/);
  });

  it('switches schedules and searches with buttons', async () => {
    await say('/schedule score 0 9 * * *');
    await say('/schedule');
    const list = telegram.sent.at(-1)!;
    const on = list.keyboard![0]![0]!;
    expect(on.text).toMatch(/включить score/);

    await bot.handleUpdate({ update_id: 500, callback_query: { id: 'q1', data: on.data, message: { message_id: 7, chat: { id: chatId } } } });
    expect(telegram.sent.at(-2)).toMatchObject({ method: 'editMessageText', text: expect.stringMatching(/score.*вкл/) });
    expect(telegram.sent.at(-1)).toEqual({ method: 'answerCallbackQuery', callbackText: 'Включено' });
    expect(bot.scheduler.nextAt).toEqual(new Date('2026-11-05T09:00:00Z'));

    const remove = telegram.sent.at(-2)!.keyboard![0]![1]!;
    await bot.handleUpdate({ update_id: 501, callback_query: { id: 'q2', data: remove.data, message: { message_id: 7, chat: { id: chatId } } } });
    expect(telegram.sent.at(-2)).toMatchObject({ method: 'editMessageText', text: expect.stringMatching(/Расписаний нет/) });
    expect(bot.scheduler.nextAt).toBeNull();

    // A button pressed twice: the schedule is gone, the bot says so in the button answer.
    await bot.handleUpdate({ update_id: 502, callback_query: { id: 'q3', data: remove.data, message: { message_id: 7, chat: { id: chatId } } } });
    expect(telegram.sent.at(-1)).toEqual({ method: 'answerCallbackQuery', callbackText: 'Расписание не найдено.' });

    await say('/searches');
    expect(telegram.sent.at(-1)!.text).toContain('✅ linkedin «node.js» (Ireland) easy apply −java');
    const off = telegram.sent.at(-1)!.keyboard![0]![0]!;
    await bot.handleUpdate({ update_id: 503, callback_query: { id: 'q4', data: off.data, message: { message_id: 8, chat: { id: chatId } } } });
    expect(searches[0]!.enabled).toBe(false);
    expect(telegram.sent.at(-1)).toEqual({ method: 'answerCallbackQuery', callbackText: 'Поиск выключен' });
  });

  it('/search adds a saved search, the 🗑 button deletes it', async () => {
    await say('/search typescript | Remote | +backend | -java');
    expect(telegram.texts().at(-1)).toMatch(/^Поиск добавлен: ✅ linkedin «typescript» \(Remote\) easy apply \+backend −java/);
    expect(searches.map((search) => search.keywords)).toEqual(['node.js', 'typescript']);

    await say('/search');
    expect(telegram.texts().at(-1)).toMatch(/^Формат: \/search &lt;ключевые слова&gt;/);

    await say('/searches');
    const list = telegram.sent.at(-1)!;
    expect(list.text).toContain('2. ✅ linkedin «typescript» (Remote)');
    const remove = list.keyboard![1]![1]!;
    expect(remove.text).toBe('🗑 2. удалить');
    await bot.handleUpdate({ update_id: 600, callback_query: { id: 'q5', data: remove.data, message: { message_id: 9, chat: { id: chatId } } } });
    expect(searches.map((search) => search.keywords)).toEqual(['node.js']);
    expect(telegram.sent.at(-2)).toMatchObject({ method: 'editMessageText', text: expect.not.stringContaining('typescript') });
    expect(telegram.sent.at(-1)).toEqual({ method: 'answerCallbackQuery', callbackText: 'Поиск удалён' });
  });

  it('/run apply sends forms for ✅ / ❌ and agent questions; ✅ submits, ❌ skips, a reply answers', async () => {
    const row = (id: string, number: number) => ({ id, url: linkedinUrl(number), title: `Job ${id}`, company: 'Acme', source: 'linkedin' });
    applyTracker.toApply = [row('jt-a', 4000000101), row('jt-b', 4000000102), row('jt-c', 4000000103)];
    applyAgent.steps.push(
      agentAnswer('ready_to_submit', { filled: [{ field: 'Email', value: 'owner@example.test' }] }),
      agentAnswer('ready_to_submit'),
      agentAnswer('needs_input', { questions: ['Years of TypeScript <experience>?'] }),
    );
    await say('/run apply limit=5');
    expect(telegram.texts()[0]).toMatch(/Запускаю <b>apply<\/b>/);
    await bot.settled();

    const texts = telegram.texts();
    expect(texts[1]).toMatch(/^✅ <b>apply<\/b> вручную/);
    expect(texts[1]).toContain('ready: Job jt-a — Acme');
    const forms = telegram.sent.filter((item) => item.keyboard?.[0]?.[0]?.data.startsWith('a:ok:'));
    expect(forms).toHaveLength(2);
    expect(forms[0]!.text).toContain('• Email: owner@example.test');
    const questionIndex = telegram.sent.findIndex((item) => item.text?.startsWith('❓'));
    expect(telegram.sent[questionIndex]!.text).toContain('Years of TypeScript &lt;experience&gt;?');
    const [okA] = forms[0]!.keyboard![0]!;
    const [, noB] = forms[1]!.keyboard![0]!;

    applyAgent.steps.push(agentAnswer('submitted'));
    await bot.handleUpdate({ update_id: ++updateId, callback_query: { id: 'cb-ok', data: okA!.data, message: { message_id: 50, chat: { id: chatId } } } });
    await bot.settled();
    expect(applyAgent.requests.at(-1)).toMatchObject({ mode: 'submit', resumeSessionId: 'session-1' });
    expect(applyTracker.marks.map((mark) => mark.jobId)).toEqual(['jt-a']);
    expect(telegram.texts().at(-1)).toMatch(/Job jt-a<\/b> — Acme: отправлено и отмечено в Job-Tracker/);
    expect((await database.job.findFirstOrThrow({ where: { trackerId: 'jt-a' } })).status).toBe('applied');

    await bot.handleUpdate({ update_id: ++updateId, callback_query: { id: 'cb-no', data: noB!.data, message: { message_id: 51, chat: { id: chatId } } } });
    expect(telegram.sent.find((item) => item.method === 'editMessageText' && item.text?.startsWith('❌'))).toBeTruthy();
    expect(await database.job.findFirstOrThrow({ where: { trackerId: 'jt-b' } })).toMatchObject({ status: 'skipped', why: 'отклонено вручную' });

    // The fake Telegram numbers messages by their position, so the question's message id is its index + 1.
    await bot.handleUpdate({
      update_id: ++updateId,
      message: { message_id: 900, chat: { id: chatId }, date: Math.floor(now.getTime() / 1000), text: '1 year', reply_to_message: { message_id: questionIndex + 1, chat: { id: chatId } } },
    });
    expect(telegram.texts().at(-1)).toMatch(/Записано в банк ответов[\s\S]*1 year[\s\S]*снова в очереди/);
    expect(await database.answer.findMany({ where: { userId: owner.id } })).toEqual([
      expect.objectContaining({ question: 'Years of TypeScript <experience>?', answer: '1 year', origin: 'telegram' }),
    ]);
    expect((await database.job.findFirstOrThrow({ where: { trackerId: 'jt-c' } })).status).toBe('queued');

    // A reply to anything else is not an answer.
    await bot.handleUpdate({
      update_id: ++updateId,
      message: { message_id: 901, chat: { id: chatId }, date: Math.floor(now.getTime() / 1000), text: 'hm', reply_to_message: { message_id: 1, chat: { id: chatId } } },
    });
    expect(telegram.texts().at(-1)).toMatch(/Не понял/);
    await say('/pending');
    expect(telegram.texts().at(-1)).toBe('Ничего не ждёт ✅ и открытых вопросов нет.');
  });

  it('shows status, queued and the answer bank, and adds an answer from Telegram', async () => {
    await say('/status');
    expect(telegram.texts()[0]).toContain('<b>Вакансии</b>: всего 11 — found 3, queued 2, rejected 5, skipped 1');
    expect(telegram.texts()[0]).toContain('пока не было');
    await say('/queued');
    expect(telegram.texts()[1]).toMatch(/1\. <b>88<\/b> Node &lt;Engineer&gt; — Acme\n {3}https:\/\/www\.linkedin\.com\/jobs\/view\/1\//);
    await say('/answers');
    expect(telegram.texts()[2]).toMatch(/Банк ответов пуст/);
    await say('/answer Years of experience with TypeScript? = 1');
    expect(answers).toEqual([expect.objectContaining({ question: 'Years of experience with TypeScript?', answer: '1', origin: 'telegram' })]);
    await say('/answers');
    expect(telegram.texts()[4]).toContain('Years of experience with TypeScript?\n  → 1 (telegram)');
    await say('just text');
    expect(telegram.texts()[5]).toMatch(/\/help/);
  });

  it('runs a schedule on time, stays quiet when nothing changed, and does not catch up missed runs', async () => {
    await say('/schedule collect 0 11 * * *');
    await say('/on collect');
    telegram.sent.length = 0;
    expect(timer.pending?.ms).toBe(60 * 60_000);

    now = new Date('2026-11-04T11:00:00Z');
    timer.pending!.callback();
    await new Promise((resolve) => setImmediate(resolve));
    await bot.settled();
    expect(collectSignals).toHaveLength(1);
    // A collect run with nothing wrong: no message under the "changes" policy.
    expect(telegram.sent).toEqual([]);
    const [run] = await schedules.recentRuns(owner);
    expect(run).toMatchObject({ task: 'collect', trigger: 'schedule', status: 'ok' });
    expect((await schedules.list(owner))[0]).toMatchObject({ lastStatus: 'ok' });
    expect(bot.scheduler.nextAt).toEqual(new Date('2026-11-05T11:00:00Z'));

    // The machine slept through the next run: it is skipped, the one after is planned.
    now = new Date('2026-11-05T13:00:00Z');
    await bot.scheduler.tick();
    expect(collectSignals).toHaveLength(1);
    expect(bot.scheduler.nextAt).toEqual(new Date('2026-11-06T11:00:00Z'));
  });

  it('reports a busy scheduled run', async () => {
    collectGate = gate();
    await say('/run collect');
    await say('/schedule score 0 11 * * *');
    await say('/on score');
    now = new Date('2026-11-04T11:00:00Z');
    await bot.scheduler.tick();
    await new Promise((resolve) => setImmediate(resolve));
    expect(telegram.texts().at(-1)).toMatch(/⛔ <b>score<\/b> по расписанию\nзанято: collect/);
    collectGate.open();
    await bot.settled();
    expect((await schedules.list(owner))[0]).toMatchObject({ task: 'score', lastStatus: 'busy' });
  });
});

describe('Scheduler alone', () => {
  const schedule = (overrides: Partial<Schedule> = {}): Schedule => ({
    id: 'a', task: 'cycle', cron: '0 9 * * *', timezone: 'Europe/Dublin', enabled: true, options: {},
    lastRunAt: null, lastStatus: null, lastSummary: null, createdAt: '', updatedAt: '', ...overrides,
  });

  it('fires every schedule due at the same minute once, and skips one changed meanwhile', async () => {
    let now = new Date('2026-10-24T07:59:00Z');
    let stored = [schedule({ id: 'a' }), schedule({ id: 'b', task: 'score' })];
    const fired: string[] = [];
    const timer = fakeTimer();
    const scheduler = new Scheduler({
      list: async () => stored,
      find: async (id) => stored.find((item) => item.id === id) ?? null,
      nextRun: (item, after) => (item.enabled ? cronCalendar.next(item.cron, item.timezone, after) : null),
      fire: (item) => fired.push(item.id),
      now: () => now,
      timer,
      warn: () => {},
    });
    await scheduler.refresh();
    expect(timer.pending?.ms).toBe(60_000);

    stored = [stored[0]!, schedule({ id: 'b', task: 'score', cron: '0 10 * * *' })];
    now = new Date('2026-10-24T08:00:00Z');
    timer.pending!.callback();
    await new Promise((resolve) => setImmediate(resolve));
    expect(fired).toEqual(['a']);
    // Next: b at 10:00 local (09:00Z, summer time).
    expect(scheduler.nextAt).toEqual(new Date('2026-10-24T09:00:00Z'));

    scheduler.stop();
    expect(timer.pending).toBeNull();
    await scheduler.refresh();
    expect(timer.pending).toBeNull();
  });
});
