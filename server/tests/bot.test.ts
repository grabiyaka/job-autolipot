import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '../generated/prisma/client.js';
import { acquireBrowserLock, BrowserBusyError } from '../plugins/browser-lock.js';
import type { RemoteBrowserEnd, RemoteBrowserPort } from '../plugins/remote-browser.js';
import { cronCalendar } from '../plugins/cron.js';
import { createPrismaClient } from '../plugins/database.js';
import type { InlineKeyboard, TelegramClient, TelegramUpdate } from '../plugins/telegram.js';
import { browserLabel, browserOpenedMessage, externalMessageMax, fieldValueMax, manualMessage, menuCommands, parseCallback, parseCommand, parseOptions, readyMessage, submittedMessage } from '../scripts/bot-commands.js';
import { Scheduler, shouldReport, TelegramBot } from '../scripts/bot-runtime.js';
import type { BotOwner, BotServices, TaskOutcome, Timer } from '../scripts/bot-runtime.js';
import type { PipelineOutput } from '../scripts/pipeline-tasks.js';
import type { Answer } from '../src/answers/AnswerTypes.js';
import type { ApplicationApi, ApplicationView } from '../src/applications/ApplicationTypes.js';
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
    expect(parseCommand('/cycle')).toEqual({ kind: 'run', task: 'cycle', options: {} });
    expect(parseCommand('/apply@JobAutopilotBot limit=2')).toEqual({ kind: 'run', task: 'apply', options: { limit: 2 } });
    expect(parseCommand('/collect wat')).toMatchObject({ kind: 'invalid', message: expect.stringMatching(/Неизвестный флаг/) });
    for (const { command, description } of menuCommands) {
      expect(command).toMatch(/^[a-z0-9_]{1,32}$/);
      expect(description.length).toBeLessThanOrEqual(256);
      expect(parseCommand(`/${command}`)).not.toBeNull();
      expect(parseCommand(`/${command}`)).not.toMatchObject({ message: expect.stringMatching(/Неизвестная команда/) });
    }
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
    expect(parseCallback('a:me:app-1')).toEqual({ kind: 'application', action: 'appliedByHand', id: 'app-1' });
    expect(parseCallback('a:br:app-1')).toEqual({ kind: 'application', action: 'openBrowser', id: 'app-1' });
    expect(parseCallback('a:acc:app-1')).toEqual({ kind: 'application', action: 'accountReady', id: 'app-1' });
    expect(parseCallback('a:bx:app-1')).toEqual({ kind: 'application', action: 'closeBrowser', id: 'app-1' });
    expect(parseCallback('a:del:app-1')).toBeNull();
    expect(parseCallback('x')).toBeNull();
    expect(parseCallback(undefined)).toBeNull();
  });
});

const attemptView = (overrides: Partial<ApplicationView> = {}): ApplicationView => ({
  id: 'app-1', jobId: 'j1', jobTitle: 'Node <Dev>', company: 'Acme & Co', url: 'https://www.linkedin.com/jobs/view/1/',
  status: 'ready', kind: 'external', applyUrl: 'https://boards.greenhouse.io/acme/jobs/1?x="1"', filled: [], summary: null, note: null,
  inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, costMicros: 0, startedAt: '', finishedAt: null, ...overrides,
});

describe('apply messages', () => {
  it('a form the agent sent: link, Job-Tracker, every question with its answer and the screenshot count', () => {
    const application = attemptView({ status: 'applied', kind: 'easy_apply', applyUrl: 'https://www.linkedin.com/jobs/view/1/', filled: [{ field: 'Notice <period>?', value: '1 month' }] });
    const text = submittedMessage({ application, screenshots: ['/a/001.png', '/a/002.png'], tracker: 'отправлено и отмечено в Job-Tracker' });
    expect(text).toContain('🚀 <b>Отправлено агентом</b>: Node &lt;Dev&gt; — Acme &amp; Co');
    expect(text).toContain('Форма: <a href="https://www.linkedin.com/jobs/view/1/">www.linkedin.com</a>');
    expect(text).toContain('Job-Tracker: отправлено и отмечено в Job-Tracker');
    expect(text).toContain('<b>Вопросы и ответы</b>:\n• Notice &lt;period&gt;?: 1 month');
    expect(text).toContain('Скриншоты формы: 2 — ниже.');
    expect(submittedMessage({ application, screenshots: [], tracker: 'x' })).toContain('Скриншотов нет');
  });

  it('an external form shows the host as a link and the filled fields; Easy Apply stays as it was', () => {
    const external = readyMessage(attemptView({ filled: [{ field: 'Email', value: 'a@b.test' }, { field: 'Why <us>?', value: 'Fit & growth' }] }));
    expect(external.text).toContain('🌐 <b>Внешняя форма заполнена, ждёт ✅</b>: Node &lt;Dev&gt; — Acme &amp; Co');
    expect(external.text).toContain('Форма: <a href="https://boards.greenhouse.io/acme/jobs/1?x=&quot;1&quot;">boards.greenhouse.io</a>');
    expect(external.text).toContain('• Email: a@b.test\n• Why &lt;us&gt;?: Fit &amp; growth');
    expect(external.text).toContain('✅ — агент заполнит форму заново и отправит (пара минут)');
    expect(external.keyboard).toEqual([[{ text: '✅ отправить', data: 'a:ok:app-1' }, { text: '❌ отказаться', data: 'a:no:app-1' }]]);

    const easy = readyMessage(attemptView({ kind: 'easy_apply', filled: [{ field: 'Email', value: 'a@b.test' }] }));
    expect(easy.text).toMatch(/^📝 <b>Заполнено, ждёт ✅<\/b>/);
    expect(easy.text).not.toContain('<a href');
  });

  it('cuts long values and a long field list to one message', () => {
    const filled = Array.from({ length: 60 }, (_, index) => ({ field: `Question ${index}`, value: 'x'.repeat(400) }));
    const { text } = readyMessage(attemptView({ filled, summary: 'Всё заполнено.' }));
    expect(text.length).toBeLessThanOrEqual(externalMessageMax);
    expect(text).toContain(`• Question 0: ${'x'.repeat(fieldValueMax - 1)}…\n`);
    expect(text).not.toContain('x'.repeat(fieldValueMax));
    const shown = text.split('\n').filter((line) => line.startsWith('• ')).length;
    expect(shown).toBeGreaterThan(5);
    expect(text).toContain(`…и ещё ${60 - shown} `);
    expect(text).toContain('Всё заполнено.');
    expect(text.trimEnd().endsWith('❌ — отказаться.')).toBe(true);
  });

  it('a manual job: reason, link and the «подал сам» / «не подаю» buttons', () => {
    const { text, keyboard } = manualMessage(attemptView({
      status: 'manual', applyUrl: 'https://acme.wd3.myworkdayjobs.com/en/job/1', note: 'подать вручную: Workday <аккаунт>',
    }));
    expect(text).toContain('🖐 <b>Подать вручную</b>: Node &lt;Dev&gt; — Acme &amp; Co');
    expect(text).toContain('Причина: подать вручную: Workday &lt;аккаунт&gt;');
    expect(text).toContain('Ссылка: <a href="https://acme.wd3.myworkdayjobs.com/en/job/1">acme.wd3.myworkdayjobs.com</a>');
    expect(keyboard).toEqual([
      [{ text: '✅ подал сам', data: 'a:me:app-1' }, { text: '❌ не подаю', data: 'a:no:app-1' }],
      [{ text: '🖥 Открыть браузер', data: 'a:br:app-1' }],
    ]);
    const uuid = '0f8b6c1e-3a7d-4c2b-9e51-7a2d4c6b8e90';
    for (const button of manualMessage(attemptView({ id: uuid, status: 'manual' })).keyboard.flat()) {
      expect(Buffer.byteLength(button.data!)).toBeLessThanOrEqual(64);
      expect(parseCallback(button.data)).toMatchObject({ kind: 'application', id: uuid });
    }
  });
});

describe('remote browser messages', () => {
  it('opens as a Mini App over https, as a link otherwise; the buttons fit 64 bytes', () => {
    const uuid = '0f8b6c1e-3a7d-4c2b-9e51-7a2d4c6b8e90';
    const { text, keyboard } = browserOpenedMessage(uuid, 'https://acme.wd3.myworkdayjobs.com/en/job/1', 'https://rb.example.test:8444/s/tok', 30);
    expect(text).toBe('🖥 Браузер открыт: acme.wd3.myworkdayjobs.com. Зарегистрируйся / войди, затем «✅ Аккаунт готов». Сессия закроется через 30 мин без действий.');
    expect(keyboard).toEqual([
      [{ text: '🖥 Открыть', webApp: 'https://rb.example.test:8444/s/tok' }],
      [{ text: '✅ Аккаунт готов', data: `a:acc:${uuid}` }, { text: '✖️ Закрыть', data: `a:bx:${uuid}` }],
    ]);
    for (const button of keyboard.flat().filter((item) => item.data)) {
      expect(Buffer.byteLength(button.data!)).toBeLessThanOrEqual(64);
      expect(parseCallback(button.data)).toMatchObject({ kind: 'application', id: uuid });
    }
    expect(browserOpenedMessage('a', 'https://x.example/', 'http://127.0.0.1:3420/s/tok', 30).keyboard[0]).toEqual([{ text: '🖥 Открыть', url: 'http://127.0.0.1:3420/s/tok' }]);
    expect(browserLabel('https://acme.wd3.myworkdayjobs.com/en/job/1')).toBe('браузер (acme.wd3.myworkdayjobs.com)');
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

type Sent = { method: string; chatId?: number; text?: string; keyboard?: InlineKeyboard; callbackText?: string; files?: readonly string[] };
function fakeTelegram() {
  const sent: Sent[] = [];
  const client: TelegramClient = {
    getUpdates: async () => [],
    async sendMessage(chatId, text, options = {}) { sent.push({ method: 'sendMessage', chatId, text, ...(options.keyboard ? { keyboard: options.keyboard } : {}) }); return sent.length; },
    async editMessageText(chatId, _messageId, text, options = {}) { sent.push({ method: 'editMessageText', chatId, text, ...(options.keyboard ? { keyboard: options.keyboard } : {}) }); },
    async answerCallbackQuery(_id, text) { sent.push({ method: 'answerCallbackQuery', ...(text ? { callbackText: text } : {}) }); },
    async sendPhotos(chatId, files, caption) { sent.push({ method: 'sendPhotos', chatId, files, ...(caption ? { text: caption } : {}) }); },
    async setMyCommands(commands) { sent.push({ method: 'setMyCommands', text: commands.map((item) => item.command).join(' ') }); },
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

/** The remote browser without a browser: what was opened and closed, and the expiry fired by hand. */
function fakeRemoteBrowser() {
  const remote = {
    events: [] as string[],
    failWith: null as Error | null,
    onExpire: null as ((reason: RemoteBrowserEnd) => void) | null,
    port: {
      async open(url, onExpire) {
        if (remote.failWith) throw remote.failWith;
        remote.events.push(`open ${url}`);
        remote.onExpire = onExpire;
        return { link: 'https://rb.example.test:8444/s/token', close: async () => { remote.events.push('close'); } };
      },
    } as RemoteBrowserPort,
  };
  return remote;
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
  let scoreGate: ReturnType<typeof gate> | null;
  let collectSignals: AbortSignal[];
  let scoreCalls: { ownerId: string; options: ScoringOptions }[];
  let searches: Search[];
  let answers: Answer[];
  let trackerConfigured: boolean;
  let applyTracker: FakeApplyTracker;
  let applyAgent: FakeAgent;
  let submitGate: ReturnType<typeof gate> | null;
  let applicationCalls: string[];
  let remote: ReturnType<typeof fakeRemoteBrowser>;

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
    scoreGate = null;
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
    const counts = { found: 3, scored: 0, rejected: 5, queued: 2, applying: 0, applied: 0, needs_input: 0, failed: 0, skipped: 1, manual: 1 } as Record<JobStatus, number>;
    submitGate = null;
    applicationCalls = [];
    remote = fakeRemoteBrowser();
    // The real service, with the calls the bot makes written down and ✅ held open by `submitGate`.
    const real: ApplicationApi = applier.applications;
    const applications: BotServices['applications'] = {
      fillNext: (ownerId, options) => real.fillNext(ownerId, options),
      submit: async (ownerId, id, signal) => {
        applicationCalls.push(`submit ${id}`);
        if (submitGate) await submitGate.promise;
        return real.submit(ownerId, id, signal);
      },
      markManualApplied: (ownerId, id) => { applicationCalls.push(`manual ${id}`); return real.markManualApplied(ownerId, id); },
      reject: (ownerId, id) => { applicationCalls.push(`reject ${id}`); return real.reject(ownerId, id); },
      answerQuestion: (...args) => real.answerQuestion(...args),
      pending: (ownerId) => real.pending(ownerId),
      setQuestionMessage: (...args) => real.setQuestionMessage(...args),
      findQuestionByMessage: (...args) => real.findQuestionByMessage(...args),
    };
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
      applications,
      remoteBrowser: remote.port,
      pipeline: {
        get trackerConfigured() { return trackerConfigured; },
        lockBrowser: (task) => acquireBrowserLock({ task: `bot:${task}`, path: lockPath }),
        openCollector: (log) => ({
          searches: {
            runSaved: async (options) => {
              collectSignals.push(options.signal);
              log?.info('linkedin «node.js» стр. 2: карточек 25, новых 8');
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
            scoreFound: async (ownerId, options) => {
              scoreCalls.push({ ownerId, options });
              options.onJob?.({ jobId: 'j1', title: 'Node <Engineer>', company: 'Acme', outcome: 'queued', score: 88, why: 'fits' });
              options.onJob?.({ jobId: 'j3', title: 'Java Dev', company: 'Gamma', outcome: 'rejected', score: 20, why: 'java' });
              if (scoreGate) await scoreGate.promise;
              return scoringReport();
            },
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
    expect(telegram.texts()[2]).toContain('<b>Сейчас</b>: collect, запущено 3 мин назад, этап: сбор (3 мин)\n'
      + '  linkedin «node.js» стр. 2: карточек 25, новых 8');

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

  it('/status during a cycle shows the scoring stage with counts and the last job', async () => {
    scoreGate = gate();
    await say('/run cycle');
    await new Promise((resolve) => setTimeout(resolve, 20));
    now = new Date('2026-11-04T10:02:00Z');
    await say('/status');
    const status = telegram.texts().at(-1)!;
    expect(status).toContain('<b>Сейчас</b>: cycle, запущено 2 мин назад, этап: оценка (2 мин)\n'
      + '  оценено 2, в queued 1; остаток — found выше\n'
      + '  последняя: − 20 Java Dev — Gamma');
    scoreGate.open();
    await bot.settled();
    await say('/status');
    expect(telegram.texts().at(-1)).toContain('<b>Сейчас</b>: ничего не выполняется');
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

    await bot.handleUpdate({ update_id: 500, callback_query: { id: 'q1', data: on.data!, message: { message_id: 7, chat: { id: chatId } } } });
    expect(telegram.sent.at(-2)).toMatchObject({ method: 'editMessageText', text: expect.stringMatching(/score.*вкл/) });
    expect(telegram.sent.at(-1)).toEqual({ method: 'answerCallbackQuery', callbackText: 'Включено' });
    expect(bot.scheduler.nextAt).toEqual(new Date('2026-11-05T09:00:00Z'));

    const remove = telegram.sent.at(-2)!.keyboard![0]![1]!;
    await bot.handleUpdate({ update_id: 501, callback_query: { id: 'q2', data: remove.data!, message: { message_id: 7, chat: { id: chatId } } } });
    expect(telegram.sent.at(-2)).toMatchObject({ method: 'editMessageText', text: expect.stringMatching(/Расписаний нет/) });
    expect(bot.scheduler.nextAt).toBeNull();

    // A button pressed twice: the schedule is gone, the bot says so in the button answer.
    await bot.handleUpdate({ update_id: 502, callback_query: { id: 'q3', data: remove.data!, message: { message_id: 7, chat: { id: chatId } } } });
    expect(telegram.sent.at(-1)).toEqual({ method: 'answerCallbackQuery', callbackText: 'Расписание не найдено.' });

    await say('/searches');
    expect(telegram.sent.at(-1)!.text).toContain('✅ linkedin «node.js» (Ireland) easy apply −java');
    const off = telegram.sent.at(-1)!.keyboard![0]![0]!;
    await bot.handleUpdate({ update_id: 503, callback_query: { id: 'q4', data: off.data!, message: { message_id: 8, chat: { id: chatId } } } });
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
    await bot.handleUpdate({ update_id: 600, callback_query: { id: 'q5', data: remove.data!, message: { message_id: 9, chat: { id: chatId } } } });
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
      agentAnswer('needs_input', { questions: ['Years of TypeScript <experience>?'], filled: [{ field: 'Phone', value: '+353 1 234' }] }),
    );
    await say('/run apply limit=5');
    expect(telegram.texts()[0]).toMatch(/Запускаю <b>apply<\/b>/);
    await bot.settled();

    const texts = telegram.texts();
    expect(texts[1]).toMatch(/^✅ <b>apply<\/b> вручную/);
    expect(texts[1]).toContain('ready: Job jt-a — Acme');
    const forms = telegram.sent.filter((item) => item.keyboard?.[0]?.[0]?.data?.startsWith('a:ok:'));
    expect(forms).toHaveLength(2);
    expect(forms[0]!.text).toContain('• Email: owner@example.test');
    const questionIndex = telegram.sent.findIndex((item) => item.text?.startsWith('❓'));
    expect(telegram.sent[questionIndex]!.text).toContain('Years of TypeScript &lt;experience&gt;?');
    expect(telegram.sent[questionIndex]!.text).toContain('Форма: <a href="https://www.linkedin.com/jobs/view/4000000103/">www.linkedin.com</a>');
    const [okA] = forms[0]!.keyboard![0]!;
    const [, noB] = forms[1]!.keyboard![0]!;

    applyAgent.steps.push(agentAnswer('submitted'));
    await bot.handleUpdate({ update_id: ++updateId, callback_query: { id: 'cb-ok', data: okA!.data!, message: { message_id: 50, chat: { id: chatId } } } });
    await bot.settled();
    expect(applyAgent.requests.at(-1)).toMatchObject({ mode: 'submit', resumeSessionId: 'session-1' });
    expect(applyTracker.marks.map((mark) => mark.jobId)).toEqual(['jt-a']);
    expect(telegram.texts().at(-1)).toMatch(/Job jt-a<\/b> — Acme: отправлено и отмечено в Job-Tracker/);
    expect((await database.job.findFirstOrThrow({ where: { trackerId: 'jt-a' } })).status).toBe('applied');

    await bot.handleUpdate({ update_id: ++updateId, callback_query: { id: 'cb-no', data: noB!.data!, message: { message_id: 51, chat: { id: chatId } } } });
    expect(telegram.sent.find((item) => item.method === 'editMessageText' && item.text?.startsWith('❌'))).toBeTruthy();
    expect(await database.job.findFirstOrThrow({ where: { trackerId: 'jt-b' } })).toMatchObject({ status: 'skipped', why: 'отклонено вручную' });

    // The fake Telegram numbers messages by their position, so the question's message id is its index + 1.
    // The last answer fills the form again at once, from the draft and the bank.
    applyAgent.steps.push(agentAnswer('closed'));
    const before = telegram.texts().length;
    await bot.handleUpdate({
      update_id: ++updateId,
      message: { message_id: 900, chat: { id: chatId }, date: Math.floor(now.getTime() / 1000), text: '1 year', reply_to_message: { message_id: questionIndex + 1, chat: { id: chatId } } },
    });
    await bot.settled();
    const after = telegram.texts().slice(before);
    expect(after[0]).toMatch(/Записано в банк ответов[\s\S]*1 year[\s\S]*заполняю форму заново по черновику/);
    expect(after[1]).toMatch(/^<b>apply<\/b> после ответа\nskipped: Job jt-c — Acme/);
    expect(await database.answer.findMany({ where: { userId: owner.id } })).toEqual([
      expect.objectContaining({ question: 'Years of TypeScript <experience>?', answer: '1 year', origin: 'telegram' }),
    ]);
    const refill = applyAgent.requests.at(-1)!;
    expect(refill).toMatchObject({ mode: 'fill', startUrl: linkedinUrl(4000000103) });
    expect(refill.systemPrompt).toContain('<previous_fill>\n- Phone: +353 1 234\n</previous_fill>');
    expect(refill.systemPrompt).toContain('Q: Years of TypeScript &lt;experience&gt;?\n  A: 1 year');
    expect((await database.job.findFirstOrThrow({ where: { trackerId: 'jt-c' } })).status).toBe('skipped');

    // A reply to anything else is not an answer.
    await bot.handleUpdate({
      update_id: ++updateId,
      message: { message_id: 901, chat: { id: chatId }, date: Math.floor(now.getTime() / 1000), text: 'hm', reply_to_message: { message_id: 1, chat: { id: chatId } } },
    });
    expect(telegram.texts().at(-1)).toMatch(/Не понял/);
    await say('/pending');
    expect(telegram.texts().at(-1)).toBe('Ничего не ждёт ✅ или подачи вручную, открытых вопросов нет.');
  });

  it('external forms: the field summary, ✅ fills again and sends, a manual job gets «подал сам» / «не подаю»', async () => {
    const row = (id: string, number: number) => ({ id, url: linkedinUrl(number), title: `Job ${id}`, company: 'Acme', source: 'linkedin' });
    applyTracker.toApply = [row('jt-x', 4000000201), row('jt-m', 4000000202), row('jt-n', 4000000203)];
    const greenhouse = 'https://boards.greenhouse.io/acme/jobs/201';
    applyAgent.steps.push(
      agentAnswer('ready_to_submit', { kind: 'external', applyUrl: greenhouse, filled: [{ field: 'First name', value: 'Illia' }, { field: 'Resume', value: 'cv.pdf' }] }),
      agentAnswer('manual', { kind: 'external', applyUrl: 'https://acme.wd3.myworkdayjobs.com/job/202', summary: 'Workday: нужен аккаунт' }),
      agentAnswer('manual', { kind: 'external', applyUrl: 'https://acme.wd3.myworkdayjobs.com/job/203', summary: 'капча' }),
    );
    await say('/run apply');
    await bot.settled();

    const report = telegram.texts()[1]!;
    expect(report).toContain('manual: Job jt-m — Acme. подать вручную');
    expect(report).toContain('Подать вручную: 2 — ссылки ниже');
    const form = telegram.sent.find((item) => item.text?.startsWith('🌐'))!;
    expect(form.text).toContain('Форма: <a href="https://boards.greenhouse.io/acme/jobs/201">boards.greenhouse.io</a>');
    expect(form.text).toContain('• First name: Illia\n• Resume: cv.pdf');
    const manual = telegram.sent.filter((item) => item.text?.startsWith('🖐'));
    expect(manual).toHaveLength(2);
    expect(manual[0]!.text).toContain('Workday: нужен аккаунт');
    expect(manual[0]!.text).toContain('<a href="https://acme.wd3.myworkdayjobs.com/job/202">acme.wd3.myworkdayjobs.com</a>');

    // /pending sends the form and both manual jobs again, with their buttons.
    telegram.sent.length = 0;
    await say('/pending');
    expect(telegram.sent.map((item) => item.keyboard?.[0]?.map((button) => button.data?.slice(0, 4)))).toEqual([
      ['a:ok', 'a:no'], ['a:me', 'a:no'], ['a:me', 'a:no'],
    ]);

    // ✅ on the external form: an answer at once, the submit runs as a task /status shows, then the result.
    submitGate = gate();
    applyAgent.steps.push(agentAnswer('submitted', { kind: 'external', applyUrl: greenhouse, summary: 'страница «Thank you»' }));
    const [ok] = form.keyboard![0]!;
    await bot.handleUpdate({ update_id: ++updateId, callback_query: { id: 'cb-x', data: ok!.data!, message: { message_id: 70, chat: { id: chatId } } } });
    expect(telegram.sent.at(-2)).toEqual({ method: 'answerCallbackQuery', callbackText: 'Заполняю заново и отправляю…' });
    expect(telegram.sent.at(-1)).toMatchObject({ method: 'editMessageText', text: expect.stringMatching(/^⏳ Заполняю заново и отправляю: Job jt-x — Acme/) });
    expect(telegram.sent.at(-1)!.keyboard).toBeUndefined();
    await new Promise((resolve) => setImmediate(resolve));
    await say('/status');
    expect(telegram.texts().at(-1)).toContain('<b>Сейчас</b>: submit: Job jt-x — Acme (внешняя форма: заполняю заново и отправляю), запущено 0 мин назад');
    submitGate.open();
    await bot.settled();
    expect(applicationCalls.filter((call) => call.startsWith('submit'))).toHaveLength(1);
    expect(applyAgent.requests.at(-1)).toMatchObject({ mode: 'submit_fresh', startUrl: greenhouse });
    expect(telegram.texts().at(-1)).toMatch(/^✅ <b>Job jt-x<\/b> — Acme: /);
    expect((await database.job.findFirstOrThrow({ where: { trackerId: 'jt-x' } })).status).toBe('applied');

    // «✅ подал сам» on the first manual job; «❌ не подаю» on the second.
    const [appliedByHand] = manual[0]!.keyboard![0]!;
    await bot.handleUpdate({ update_id: ++updateId, callback_query: { id: 'cb-me', data: appliedByHand!.data!, message: { message_id: 71, chat: { id: chatId } } } });
    expect(applicationCalls.at(-1)).toMatch(/^manual /);
    expect(telegram.sent.at(-3)).toEqual({ method: 'editMessageText', chatId, text: '🖐 Подано вручную: Job jt-m — Acme' });
    expect(telegram.sent.at(-2)).toEqual({ method: 'answerCallbackQuery', callbackText: 'Отмечено' });
    expect(telegram.texts().at(-1)).toMatch(/^✅ <b>Job jt-m<\/b> — Acme: /);
    expect(applyTracker.marks.find((mark) => mark.jobId === 'jt-m')?.input.channel).toBe('company_site_manual');
    expect((await database.job.findFirstOrThrow({ where: { trackerId: 'jt-m' } })).status).toBe('applied');

    // Pressed again: the attempt is not manual any more, the button says so.
    await bot.handleUpdate({ update_id: ++updateId, callback_query: { id: 'cb-me2', data: appliedByHand!.data!, message: { message_id: 71, chat: { id: chatId } } } });
    expect(telegram.sent.at(-1)).toMatchObject({ method: 'answerCallbackQuery', callbackText: expect.stringMatching(/только для попытки manual/) });

    const [, giveUp] = manual[1]!.keyboard![0]!;
    await bot.handleUpdate({ update_id: ++updateId, callback_query: { id: 'cb-no', data: giveUp!.data!, message: { message_id: 72, chat: { id: chatId } } } });
    expect(applicationCalls.at(-1)).toMatch(/^reject /);
    expect(telegram.sent.at(-2)).toMatchObject({ method: 'editMessageText', text: '❌ Отклонено: Job jt-n — Acme' });
    expect(await database.job.findFirstOrThrow({ where: { trackerId: 'jt-n' } })).toMatchObject({ status: 'skipped', why: 'отклонено вручную' });

    await say('/pending');
    expect(telegram.texts().at(-1)).toBe('Ничего не ждёт ✅ или подачи вручную, открытых вопросов нет.');
  });

  it('remote browser: busy, open, /status, «Аккаунт готов» → the agent again on the form, close, timeout, /stop', async () => {
    const workday = (n: number) => `https://acme.wd3.myworkdayjobs.com/job/${n}`;
    const row = (id: string, number: number) => ({ id, url: linkedinUrl(number), title: `Job ${id}`, company: 'Acme', source: 'linkedin' });
    applyTracker.toApply = [row('jt-w', 4000000301), row('jt-v', 4000000302)];
    applyAgent.steps.push(
      agentAnswer('manual', { kind: 'external', applyUrl: workday(301), summary: 'Workday: нужен аккаунт' }),
      agentAnswer('manual', { kind: 'external', applyUrl: workday(302), summary: 'Workday: нужен аккаунт' }),
    );
    await say('/run apply');
    await bot.settled();
    const manual = telegram.sent.filter((item) => item.text?.startsWith('🖐'));
    expect(manual).toHaveLength(2);
    const browserButton = (index: number) => manual[index]!.keyboard![1]![0]!;
    expect(browserButton(0)).toMatchObject({ text: '🖥 Открыть браузер', data: expect.stringMatching(/^a:br:/) });
    const press = (id: string, data: string) => bot.handleUpdate({ update_id: ++updateId, callback_query: { id, data, message: { message_id: 90, chat: { id: chatId } } } });
    const lockFree = () => { try { acquireBrowserLock({ task: 'probe', path: lockPath }).release(); return true; } catch (error) { if (error instanceof BrowserBusyError) return false; throw error; } };

    // A running task: «занято», nothing opens.
    collectGate = gate();
    await say('/run collect');
    await press('cb-busy', browserButton(0).data!);
    expect(telegram.sent.at(-1)).toMatchObject({ method: 'answerCallbackQuery', callbackText: expect.stringMatching(/^занято: collect/) });
    collectGate.open();
    await bot.settled();
    expect(remote.events).toEqual([]);

    // Open: the form of the manual attempt, the Mini App link and the two buttons; the runner and the lock are taken.
    await press('cb-open', browserButton(0).data!);
    expect(remote.events).toEqual([`open ${workday(301)}`]);
    const opened = telegram.sent.at(-1)!;
    expect(opened.text).toBe('🖥 Браузер открыт: acme.wd3.myworkdayjobs.com. Зарегистрируйся / войди, затем «✅ Аккаунт готов». Сессия закроется через 30 мин без действий.');
    expect(opened.keyboard![0]).toEqual([{ text: '🖥 Открыть', webApp: 'https://rb.example.test:8444/s/token' }]);
    const [ready] = opened.keyboard![1]!;
    expect(ready!.data).toMatch(/^a:acc:/);
    expect(lockFree()).toBe(false);
    await say('/status');
    expect(telegram.texts().at(-1)).toContain('<b>Сейчас</b>: браузер (acme.wd3.myworkdayjobs.com), запущено 0 мин назад');
    await say('/run collect');
    expect(telegram.texts().at(-1)).toContain('занято: браузер (acme.wd3.myworkdayjobs.com)');
    await press('cb-open2', browserButton(1).data!);
    expect(telegram.sent.at(-1)).toMatchObject({ method: 'answerCallbackQuery', callbackText: expect.stringMatching(/^Браузер уже открыт/) });

    // «✅ Аккаунт готов»: the session closes, the agent fills this job again starting on the signed-in form.
    applyAgent.steps.push(agentAnswer('ready_to_submit', { kind: 'external', applyUrl: workday(301), filled: [{ field: 'Email', value: 'owner@example.test' }] }));
    await press('cb-ready', ready!.data!);
    await bot.settled();
    expect(remote.events).toEqual([`open ${workday(301)}`, 'close']);
    expect(telegram.texts()).toContain('Аккаунт готов — запускаю агента на эту вакансию: Job jt-w — Acme…');
    expect(applyAgent.requests.at(-1)).toMatchObject({ mode: 'fill', startUrl: workday(301) });
    expect(applyAgent.requests.at(-1)!.prompt).toContain(`where the owner has just signed in: ${workday(301)}`);
    expect(applyAgent.requests.at(-1)!.systemPrompt).toContain('The owner has just created an account');
    expect(telegram.texts().some((text) => text.startsWith('<b>apply</b> после «Аккаунт готов»'))).toBe(true);
    expect(telegram.sent.at(-1)!.text).toMatch(/^🌐 <b>Внешняя форма заполнена, ждёт ✅<\/b>: Job jt-w/);
    expect(lockFree()).toBe(true);
    expect(telegram.texts()).not.toContain('Браузер закрыт.');

    // «✖️ Закрыть».
    await press('cb-open3', browserButton(1).data!);
    const second = telegram.sent.at(-1)!.keyboard![1]!;
    await press('cb-close', second[1]!.data!);
    expect(remote.events.at(-1)).toBe('close');
    expect(telegram.texts().at(-1)).toBe('Браузер закрыт.');
    expect(lockFree()).toBe(true);
    await press('cb-close2', second[1]!.data!);
    expect(telegram.sent.at(-1)).toMatchObject({ method: 'answerCallbackQuery', callbackText: 'Браузер уже закрыт.' });

    // 30 minutes without actions.
    await press('cb-open4', browserButton(1).data!);
    remote.onExpire!('idle');
    await bot.settled();
    expect(remote.events.at(-1)).toBe('close');
    expect(telegram.texts().at(-1)).toBe('Браузер закрыт (30 мин без действий).');
    expect(lockFree()).toBe(true);

    // /stop closes it too, and the runner is free again.
    await press('cb-open5', browserButton(1).data!);
    await say('/stop');
    expect(remote.events.at(-1)).toBe('close');
    expect(telegram.texts().at(-1)).toBe('Браузер закрыт.');
    await say('/status');
    expect(telegram.texts().at(-1)).toContain('<b>Сейчас</b>: ничего не выполняется');

    // It does not open: the error is said, nothing stays taken.
    remote.failWith = new Error('Playwright MCP initialize: недоступен');
    await press('cb-open6', browserButton(1).data!);
    expect(telegram.texts().at(-1)).toBe('Браузер не открылся: Playwright MCP initialize: недоступен');
    expect(lockFree()).toBe(true);
    expect(bot.runner.busyText()).toBeNull();

    // An attempt that is not manual any more.
    await press('cb-open7', browserButton(0).data!);
    expect(telegram.sent.at(-1)).toMatchObject({ method: 'answerCallbackQuery', callbackText: 'Вакансия уже не ждёт подачи вручную.' });
  });

  it('shows status, queued and the answer bank, and adds an answer from Telegram', async () => {
    await say('/status');
    expect(telegram.texts()[0]).toContain('<b>Вакансии</b>: всего 11 — found 3, queued 2, rejected 5, skipped 1, manual 1');
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
