import type { BrowserLock } from '../plugins/browser-lock.js';
import { BrowserBusyError } from '../plugins/browser-lock.js';
import { escapeHtml } from '../plugins/telegram.js';
import type { TelegramClient, TelegramUpdate } from '../plugins/telegram.js';
import { ApplicationError } from '../framework/core/errors.js';
import type { Actor } from '../framework/core/actor.js';
import type { AnswerApi, Answer } from '../src/answers/AnswerTypes.js';
import type { ApplicationApi, ApplicationView, QuestionView, SubmittedView } from '../src/applications/ApplicationTypes.js';
import type { JobService } from '../src/jobs/JobService.js';
import { DEFAULT_TASK_MINUTES, taskOptions } from '../src/schedules/ScheduleService.js';
import type { PipelineTask, Schedule, ScheduleService, TaskOptions, TaskRunStatus, TaskTrigger } from '../src/schedules/ScheduleService.js';
import type { ScoringLine } from '../src/scoring/ScoringService.js';
import type { SearchService } from '../src/searches/SearchService.js';
import type { Logger } from '../src/searches/SearchTypes.js';
import {
  answersText, applyReportLines, helpText, manualMessage, menuCommands, minutesAgo, progressText, questionMessage, readyMessage, submitLabel, submitResultText, submittedMessage, parseCallback, parseCommand, queuedText, scheduleLine, scheduleSaved, schedulesMessage, searchesMessage,
  searchLine, statusText,
} from './bot-commands.js';
import type { ApplicationAction, BotCommand, TaskProgress } from './bot-commands.js';
import { cycleSummaryLines, queuedCount, scoringProblems, scoringSummaryLines, searchReportLines } from './pipeline-cli.js';
import type { CycleScore, CycleStage, StopWording } from './pipeline-cli.js';
import { collectJobs, runCycle, scoreOwners } from './pipeline-tasks.js';
import type { CollectorPort, PipelineOutput, ScorerPort } from './pipeline-tasks.js';

/**
 * The bot process without its entry point: one task at a time, the schedule timer and the command
 * dispatcher. Everything outside (Telegram, services, clock, timers) is passed in, so tests run it on fakes.
 */

export const botStopWording: StopWording = {
  collect: 'остановлен (/stop или предел времени)',
  score: 'остановлен по /stop или по времени',
};

/** When a scheduled run reports: `changes` — new queued jobs or problems only; `always` — after every run. */
export type ScheduledReportPolicy = 'changes' | 'always';

export type BotOwner = Actor & Readonly<{ email: string }>;

export type PipelinePorts = Readonly<{
  trackerConfigured: boolean;
  /** Throws BrowserBusyError when another task of this app holds the agent Chromium. */
  lockBrowser(task: string): BrowserLock;
  /** `log` gets the collector's page lines (the bot keeps the last one for /status). */
  openCollector(log?: Logger): CollectorPort;
  openScorer(): ScorerPort & Readonly<{ close(): Promise<void> }>;
}>;

export type BotServices = Readonly<{
  jobs: Pick<JobService, 'summary' | 'list'>;
  searches: Pick<SearchService, 'list' | 'create' | 'update' | 'remove'>;
  answers: Readonly<{ list(actor: Actor): Promise<Answer[]> }> & Pick<AnswerApi, 'upsert'>;
  schedules: Pick<ScheduleService,
    'list' | 'put' | 'setEnabled' | 'setEnabledById' | 'remove' | 'find' | 'nextRun' | 'startRun' | 'finishRun' | 'recordBusy' | 'recentRuns'>;
  pipeline: PipelinePorts;
  /** Applying: fill runs as the `apply` task, ✅ / ❌ buttons and replies to the agent's questions. */
  applications: Pick<ApplicationApi,
    'fillNext' | 'submit' | 'markManualApplied' | 'reject' | 'answerQuestion' | 'pending' | 'setQuestionMessage' | 'findQuestionByMessage'>;
}>;

// ── One task at a time ──

export type TaskOutcome = Readonly<{
  task: PipelineTask;
  trigger: TaskTrigger;
  status: Exclude<TaskRunStatus, 'running'>;
  /** Report lines (plain text, not escaped). */
  lines: string[];
  /** Jobs that went to queued in this run. */
  queued: number;
  /** Errors worth a message even after a quiet scheduled run. */
  problems: boolean;
  minutes: number;
  /** Apply runs: the forms waiting for ✅, the agent's questions and the jobs to apply to by hand, each its own message. */
  apply?: ApplyMessages;
}>;

export type ApplyMessages = Readonly<{
  ready: readonly ApplicationView[]; questions: readonly QuestionView[]; manual: readonly ApplicationView[];
  /** Forms the agent sent itself (APPLY_AUTO_SUBMIT); /pending has none. */
  submitted?: readonly SubmittedView[];
}>;

type Current = { task: string; trigger: TaskTrigger; startedAt: Date; controller: AbortController; progress: TaskProgress };

const scoredMarks: Record<ScoringLine['outcome'], string> = { queued: '+', rejected: '−', skipped: '=', changed: '~', error: '!' };
const scoredName = (line: ScoringLine): string =>
  `${scoredMarks[line.outcome]} ${'score' in line ? `${line.score} ` : ''}${line.title} — ${line.company}`;

export class TaskRunner {
  private current: Current | null = null;

  constructor(
    private readonly owner: BotOwner,
    private readonly services: Pick<BotServices, 'schedules' | 'pipeline'> & Partial<Pick<BotServices, 'applications'>>,
    private readonly now: () => Date,
    private readonly out: PipelineOutput,
  ) {}

  /** «занято: cycle, запущено 3 мин назад», or null when nothing runs. */
  busyText(): string | null {
    const current = this.current;
    return current ? `занято: ${current.task}, запущено ${minutesAgo(current.startedAt, this.now())} мин назад` : null;
  }

  /** For /status: the running task with its stage and last step (plain text), or null when idle. */
  progressText(): string | null {
    return this.current ? progressText(this.current.progress, this.now()) : null;
  }

  private start(task: string, trigger: TaskTrigger): Current {
    const startedAt = this.now();
    const progress: TaskProgress = {
      task, startedAt, stage: task === 'apply' ? 'apply' : null, stageStartedAt: task === 'apply' ? startedAt : null,
      collectLine: null, scored: 0, queued: 0, lastScored: null,
    };
    this.current = { task, trigger, startedAt, controller: new AbortController(), progress };
    return this.current;
  }

  /** The run's output: printed as before, and every step updates the progress /status shows. */
  private tracked(current: Current): { out: PipelineOutput; log: Logger } {
    const update = (change: Partial<TaskProgress>) => { current.progress = { ...current.progress, ...change }; };
    return {
      out: {
        line: this.out.line,
        warn: this.out.warn,
        step: (step) => {
          if (step.kind === 'stage') {
            if (current.progress.stage !== step.stage) update({ stage: step.stage, stageStartedAt: this.now() });
            return;
          }
          const { scored, queued } = current.progress;
          update({ scored: scored + 1, queued: queued + (step.line.outcome === 'queued' ? 1 : 0), lastScored: scoredName(step.line) });
        },
      },
      log: {
        info: (text) => { this.out.line(text); update({ collectLine: text }); },
        warn: (text) => { this.out.warn(text); update({ collectLine: `⚠️ ${text}` }); },
      },
    };
  }

  /** Aborts the running task; it finishes the current page or job first. Returns its name, null when idle. */
  stop(): string | null {
    if (!this.current) return null;
    this.current.controller.abort();
    return this.current.task;
  }

  async run(task: PipelineTask, trigger: TaskTrigger, options: TaskOptions, scheduleId: string | null = null): Promise<TaskOutcome> {
    const busy = this.busyText();
    if (busy) return this.busy(task, trigger, scheduleId, busy);

    // Collecting alone needs the browser; a cycle takes the lock itself and only skips collecting when it is busy.
    let lock: BrowserLock | null = null;
    if (task === 'collect') {
      try { lock = this.services.pipeline.lockBrowser(task); } catch (error) {
        if (!(error instanceof BrowserBusyError)) throw error;
        const { holder } = error;
        return this.busy(task, trigger, scheduleId,
          `занято: браузер — ${holder.task} (pid ${holder.pid}), запущено ${minutesAgo(holder.startedAt, this.now())} мин назад`);
      }
    }

    const current = this.start(task, trigger);
    const { startedAt } = current;
    let runId: string | null = null;
    let outcome: Omit<TaskOutcome, 'task' | 'trigger' | 'minutes'>;
    try {
      runId = (await this.services.schedules.startRun(this.owner, task, trigger, scheduleId)).id;
      outcome = await this.execute(task, options, current);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof BrowserBusyError) {
        // apply takes the browser lock inside the service.
        outcome = { status: 'busy', lines: [`занято: ${message}`], queued: 0, problems: true };
      } else {
        this.out.warn(`${task}: ${message}`);
        outcome = { status: 'error', lines: [`ошибка: ${message}`], queued: 0, problems: true };
      }
    } finally {
      lock?.release();
      this.current = null;
    }
    if (runId) {
      try { await this.services.schedules.finishRun(this.owner, runId, outcome.status, outcome.lines.join('\n')); } catch (error) {
        this.out.warn(`не удалось записать итог запуска: ${error instanceof Error ? error.message : error}`);
      }
    }
    return { ...outcome, task, trigger, minutes: minutesAgo(startedAt, this.now()) };
  }

  /**
   * Another exclusive action (the submit after ✅) under the same "one at a time" rule as the tasks.
   * Returns null and does not run it when something is running.
   */
  async exclusive<T>(label: string, action: (signal: AbortSignal) => Promise<T>): Promise<{ result: T } | null> {
    if (this.current) return null;
    const { controller } = this.start(label, 'manual');
    try {
      return { result: await action(controller.signal) };
    } finally {
      this.current = null;
    }
  }

  /** Whether a task is running now. */
  get running(): boolean {
    return this.current !== null;
  }

  private async busy(task: PipelineTask, trigger: TaskTrigger, scheduleId: string | null, text: string): Promise<TaskOutcome> {
    await this.services.schedules.recordBusy(this.owner, task, trigger, scheduleId, text);
    return { task, trigger, status: 'busy', lines: [text], queued: 0, problems: true, minutes: 0 };
  }

  private async execute(task: PipelineTask, options: TaskOptions, current: Current): Promise<Omit<TaskOutcome, 'task' | 'trigger' | 'minutes'>> {
    const { pipeline } = this.services;
    const { controller } = current;
    const { out, log } = this.tracked(current);
    const minutes = options.maxMinutes ?? DEFAULT_TASK_MINUTES;
    const deadline = AbortSignal.timeout(minutes * 60_000);
    const signal = AbortSignal.any([controller.signal, deadline]);
    const stopped = () => (controller.signal.aborted ? 'остановлено по /stop' : deadline.aborted ? `истёк предел ${minutes} мин` : null);
    const finalStatus = (failed: boolean): Exclude<TaskRunStatus, 'running'> => (signal.aborted ? 'aborted' : failed ? 'error' : 'ok');
    const scoreInput = {
      dryRun: false, push: true,
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
      ...(options.threshold !== undefined ? { threshold: options.threshold } : {}),
    };

    if (task === 'apply') {
      const applications = this.services.applications;
      if (!applications) throw new Error('подача не подключена к боту');
      const report = await applications.fillNext(this.owner.id, { signal, ...(options.limit !== undefined ? { limit: options.limit } : {}) });
      const failed = report.lines.some((line) => line.status === 'failed') || report.resent.some((item) => !item.ok);
      return {
        status: signal.aborted ? 'aborted' : 'ok', lines: applyReportLines(report), queued: 0,
        problems: failed || report.stopped === 'budget',
        apply: { ready: report.ready, questions: report.questions, manual: report.manual, submitted: report.submitted },
      };
    }

    if (task === 'collect') {
      const collector = pipeline.openCollector(log);
      try {
        const run = await collectJobs(collector, {
          adHoc: null, ownerId: this.owner.id, signal, dryRun: false, easyApplyOnly: options.easyApply ?? false,
        }, out, botStopWording);
        const lines = run.reports.length
          ? run.reports.flatMap((report) => searchReportLines(report, false, botStopWording))
          : ['Включённых сохранённых поисков нет: /searches'];
        return { status: finalStatus(run.failed), lines, queued: 0, problems: run.failed };
      } finally { await collector.close(); }
    }

    const scorer = pipeline.openScorer();
    try {
      if (task === 'score') {
        if (!pipeline.trackerConfigured) {
          return { status: 'error', lines: ['Job-Tracker не настроен (JOB_TRACKER_URL, JOB_TRACKER_TOKEN): профиль для оценки берётся оттуда.'], queued: 0, problems: true };
        }
        const run = await scoreOwners(scorer, [this.owner], { ...scoreInput, signal, namedOwner: true, announceEmpty: false }, out, botStopWording);
        const stage: CycleStage<CycleScore> = { ran: true, result: run.result };
        const lines = run.result.reports.length
          ? run.result.reports.flatMap((report) => [
            ...(report.lines.length || report.stopped !== 'end' ? [] : ['новых вакансий для оценки нет']),
            ...scoringSummaryLines(report, true, botStopWording).map((line) => line.trim())])
          : run.result.skippedOwners.map((owner) => `пропущен: ${owner.reason}`);
        return { status: finalStatus(run.failed), lines, queued: queuedCount(stage), problems: run.failed || scoringProblems(stage) > 0 || pushFailed(stage) };
      }

      const result = await runCycle({
        owner: this.owner, adHoc: null, skipCollect: options.skipCollect ?? false, easyApplyOnly: options.easyApply ?? false,
        score: scoreInput, signal, stopped, trackerConfigured: pipeline.trackerConfigured,
        lockBrowser: () => pipeline.lockBrowser('cycle'),
        openCollector: () => pipeline.openCollector(log),
        scorer, activeUsers: async () => [this.owner],
      }, out, botStopWording);
      const collectFailed = result.collect.ran && result.collect.result.reports.some((report) => report.stopped === 'error');
      return {
        status: finalStatus(result.failed),
        lines: cycleSummaryLines(result.collect, result.score, botStopWording),
        queued: queuedCount(result.score),
        problems: result.failed || collectFailed || scoringProblems(result.score) > 0 || pushFailed(result.score),
      };
    } finally { await scorer.close(); }
  }
}

const pushFailed = (score: CycleStage<CycleScore>): boolean =>
  score.ran && score.result.reports.some((report) => Boolean(report.push?.error));

/** Manual runs and problems always report; a quiet scheduled run only under `always`. */
export function shouldReport(outcome: TaskOutcome, policy: ScheduledReportPolicy): boolean {
  if (outcome.trigger === 'manual' || policy === 'always') return true;
  return outcome.status !== 'ok' || outcome.problems || outcome.queued > 0
    || Boolean(outcome.apply && (outcome.apply.ready.length || outcome.apply.questions.length || outcome.apply.manual.length
      || outcome.apply.submitted?.length));
}

const outcomeMarks: Record<TaskOutcome['status'], string> = { ok: '✅', error: '⚠️', aborted: '⏹', busy: '⛔' };

export function reportText(outcome: TaskOutcome, queued: readonly Parameters<typeof queuedText>[0][number][]): string {
  const trigger = outcome.trigger === 'manual' ? 'вручную' : 'по расписанию';
  const head = `${outcomeMarks[outcome.status]} <b>${outcome.task}</b> ${trigger}${outcome.status === 'busy' ? '' : `, ${outcome.minutes} мин`}`;
  const body = outcome.lines.map(escapeHtml).join('\n');
  const top = outcome.queued > 0 && queued.length ? `\n\n${queuedText(queued, `Новых в queued: ${outcome.queued}. Лучшие отобранные`)}` : '';
  return `${head}\n${body}${top}`;
}

// ── Schedule timer ──

export type Timer = Readonly<{
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}>;

export const realTimer: Timer = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export type SchedulerDeps = Readonly<{
  list(): Promise<Schedule[]>;
  find(id: string): Promise<Schedule | null>;
  nextRun(schedule: Schedule, after: Date): Date | null;
  fire(schedule: Schedule): void;
  now(): Date;
  timer: Timer;
  warn(message: string): void;
  /** A run whose time passed longer ago than this (the machine slept) is skipped, not caught up. */
  graceMs?: number;
  /** The timer never waits longer than this, so a changed clock is noticed. */
  maxDelayMs?: number;
}>;

/**
 * One setTimeout for the nearest run of all enabled schedules. Planned again at start, after every
 * change and after every run; missed runs (the bot was off) are not caught up.
 */
export class Scheduler {
  private handle: unknown = null;
  private plan: { at: Date; ids: string[] } | null = null;
  private stopped = false;

  constructor(private readonly deps: SchedulerDeps) {}

  /** The planned time, for /status and tests. */
  get nextAt(): Date | null {
    return this.plan?.at ?? null;
  }

  async refresh(after?: Date): Promise<void> {
    if (this.handle !== null) { this.deps.timer.clear(this.handle); this.handle = null; }
    this.plan = null;
    if (this.stopped) return;
    const now = this.deps.now();
    const from = after && after > now ? after : now;
    let plan: { at: Date; ids: string[] } | null = null;
    for (const schedule of await this.deps.list()) {
      const next = this.deps.nextRun(schedule, from);
      if (!next) continue;
      if (!plan || next < plan.at) plan = { at: next, ids: [schedule.id] };
      else if (next.getTime() === plan.at.getTime()) plan.ids.push(schedule.id);
    }
    this.plan = plan;
    if (!plan) return;
    const delay = Math.min(Math.max(plan.at.getTime() - now.getTime(), 0), this.deps.maxDelayMs ?? 60 * 60_000);
    this.handle = this.deps.timer.set(() => { void this.tick().catch((error: unknown) => this.deps.warn(`расписание: ${error instanceof Error ? error.message : error}`)); }, delay);
  }

  async tick(): Promise<void> {
    this.handle = null;
    const plan = this.plan;
    const now = this.deps.now();
    // Node may wake a moment early; a wake-up long before the plan is the maxDelay re-check.
    if (!plan || now.getTime() < plan.at.getTime() - 1000) { await this.refresh(); return; }
    const late = now.getTime() - plan.at.getTime();
    if (late > (this.deps.graceMs ?? 5 * 60_000)) {
      this.deps.warn(`пропущен запуск по расписанию ${plan.at.toISOString()} (опоздание ${Math.round(late / 60_000)} мин)`);
    } else {
      for (const id of plan.ids) {
        // The schedule may have been changed or switched off since it was planned.
        const schedule = await this.deps.find(id);
        const before = new Date(plan.at.getTime() - 1);
        if (schedule && this.deps.nextRun(schedule, before)?.getTime() === plan.at.getTime()) this.deps.fire(schedule);
      }
    }
    await this.refresh(plan.at);
  }

  stop(): void {
    this.stopped = true;
    if (this.handle !== null) this.deps.timer.clear(this.handle);
    this.handle = null;
    this.plan = null;
  }
}

// ── Commands from Telegram ──

export type BotSettings = Readonly<{
  chatId: number;
  timezone: string;
  reportPolicy: ScheduledReportPolicy;
  /** Commands older than this (sent while the bot was off) are ignored, so a restart does not replay /run. */
  staleAfterSeconds?: number;
}>;

export class TelegramBot {
  readonly runner: TaskRunner;
  readonly scheduler: Scheduler;
  private offset = 0;
  private tasks = new Set<Promise<void>>();

  constructor(
    private readonly telegram: TelegramClient,
    private readonly owner: BotOwner,
    private readonly services: BotServices,
    private readonly settings: BotSettings,
    private readonly runtime: Readonly<{ now: () => Date; timer: Timer; out: PipelineOutput }>,
  ) {
    this.runner = new TaskRunner(owner, services, runtime.now, runtime.out);
    this.scheduler = new Scheduler({
      list: async () => (await services.schedules.list(owner)).filter((schedule) => schedule.enabled),
      find: (id) => services.schedules.find(owner, id),
      nextRun: (schedule, after) => services.schedules.nextRun(schedule, after),
      fire: (schedule) => this.background(schedule.task, 'schedule', schedule.options, schedule.id),
      now: runtime.now,
      timer: runtime.timer,
      warn: runtime.out.warn,
    });
  }

  /** Waits for the tasks started from commands and schedules (tests and shutdown). */
  async settled(): Promise<void> {
    while (this.tasks.size) await Promise.all([...this.tasks]);
  }

  /** Fills the «/» menu in Telegram; a failure only warns: the commands still work typed by hand. */
  async registerCommands(): Promise<void> {
    try {
      await this.telegram.setMyCommands(menuCommands);
    } catch (error) {
      this.runtime.out.warn(`Telegram: меню команд не обновлено: ${error instanceof Error ? error.message : error}`);
    }
  }

  /** Long polling until the signal aborts; a failed request waits and tries again. */
  async poll(signal: AbortSignal, pause: (ms: number, signal: AbortSignal) => Promise<void>): Promise<void> {
    while (!signal.aborted) {
      try {
        const updates = await this.telegram.getUpdates(this.offset, { timeoutSeconds: 50, signal });
        for (const update of updates) {
          this.offset = Math.max(this.offset, update.update_id + 1);
          await this.handleUpdate(update);
        }
      } catch (error) {
        if (signal.aborted) return;
        this.runtime.out.warn(`Telegram: ${error instanceof Error ? error.message : error}`);
        await pause(5_000, signal).catch(() => undefined);
      }
    }
  }

  async handleUpdate(update: TelegramUpdate): Promise<void> {
    const { chatId } = this.settings;
    if (update.message) {
      // Anyone else gets silence: not even an error message.
      if (update.message.chat.id !== chatId || !update.message.text) return;
      const { date } = update.message;
      if (date !== undefined && this.runtime.now().getTime() / 1000 - date > (this.settings.staleAfterSeconds ?? 600)) return;
      const command = parseCommand(update.message.text);
      const repliedTo = update.message.reply_to_message?.message_id;
      if (!command && repliedTo !== undefined) {
        const text = update.message.text;
        // An error was already answered by guard, so it counts as handled.
        let handled = true;
        await this.guard(async () => { handled = await this.replyToQuestion(repliedTo, text); });
        if (handled) return;
      }
      if (!command) { await this.say('Не понял. Список команд: /help'); return; }
      await this.guard(() => this.command(command));
      return;
    }
    const query = update.callback_query;
    if (query) {
      if (query.message?.chat.id !== chatId) return;
      await this.guard(() => this.callback(query.id, query.message!.message_id, query.data), query.id);
    }
  }

  private async command(command: BotCommand): Promise<void> {
    const { schedules, jobs, searches, answers } = this.services;
    switch (command.kind) {
      case 'help': return this.say(helpText);
      case 'invalid': return this.say(escapeHtml(command.message));
      case 'status': {
        const summary = await jobs.summary(this.owner);
        return this.say(statusText({
          ...summary, current: this.runner.progressText(), runs: await schedules.recentRuns(this.owner, 5),
          schedules: await schedules.list(this.owner), timezone: this.settings.timezone,
        }));
      }
      case 'run': {
        const options = taskOptions(command.task, command.options);
        const busy = this.runner.busyText();
        if (busy) {
          const outcome = await this.runner.run(command.task, 'manual', options);
          return this.say(await this.report(outcome));
        }
        this.background(command.task, 'manual', options, null);
        return this.say(`Запускаю <b>${command.task}</b>. Остановить: /stop`);
      }
      case 'stop': {
        const task = this.runner.stop();
        return this.say(task ? `Останавливаю <b>${task}</b>: дописываю текущую страницу или вакансию…` : 'Сейчас ничего не выполняется.');
      }
      case 'schedules': {
        const message = schedulesMessage(await schedules.list(this.owner));
        await this.telegram.sendMessage(this.settings.chatId, message.text, { keyboard: message.keyboard });
        return;
      }
      case 'schedule': {
        const { schedule, created } = await schedules.put(this.owner, { task: command.task, cron: command.cron, options: command.options });
        await this.scheduler.refresh();
        return this.say(scheduleSaved(schedule, created));
      }
      case 'toggle': {
        const schedule = await schedules.setEnabled(this.owner, command.task, command.enabled);
        await this.scheduler.refresh();
        return this.say(`${command.enabled ? 'Включено' : 'Выключено'}: ${scheduleLine(schedule)}`);
      }
      case 'searches': {
        const message = searchesMessage(await searches.list(this.owner));
        await this.telegram.sendMessage(this.settings.chatId, message.text, { keyboard: message.keyboard });
        return;
      }
      case 'addSearch': {
        const search = await searches.create(this.owner, command.search);
        return this.say(`Поиск добавлен: ✅ ${searchLine(search)}\nСобрать сейчас: /run collect · сбор и оценка: /run cycle · список: /searches`);
      }
      case 'queued': {
        const page = await jobs.list(this.owner, { status: 'queued', sort: 'score', limit: 10 });
        return this.say(queuedText(page.items));
      }
      case 'answers': return this.say(answersText(await answers.list(this.owner)));
      case 'pending': {
        const pending = await this.services.applications.pending(this.owner.id);
        if (!pending.ready.length && !pending.questions.length && !pending.manual.length) {
          return this.say('Ничего не ждёт ✅ или подачи вручную, открытых вопросов нет.');
        }
        return this.sendApply(pending);
      }
      case 'answer': {
        const saved = await answers.upsert(this.owner.id, command.question, command.answer, 'telegram');
        return this.say(`Записано в банк ответов:\n• ${escapeHtml(saved.question)}\n  → ${escapeHtml(saved.answer)}`);
      }
    }
  }

  private async callback(id: string, messageId: number, data: string | undefined): Promise<void> {
    const action = parseCallback(data);
    if (!action) { await this.telegram.answerCallbackQuery(id, 'Кнопка устарела.'); return; }
    const { schedules, searches } = this.services;
    if (action.kind === 'application') return this.applicationButton(id, messageId, action.action, action.id);
    if (action.kind === 'schedule') {
      if (action.action === 'delete') await schedules.remove(this.owner, action.id);
      else await schedules.setEnabledById(this.owner, action.id, action.action === 'on');
      await this.scheduler.refresh();
      const message = schedulesMessage(await schedules.list(this.owner));
      await this.telegram.editMessageText(this.settings.chatId, messageId, message.text, { keyboard: message.keyboard });
      await this.telegram.answerCallbackQuery(id, action.action === 'delete' ? 'Удалено' : action.action === 'on' ? 'Включено' : 'Выключено');
      return;
    }
    if (action.action === 'delete') await searches.remove(this.owner, action.id);
    else await searches.update(this.owner, action.id, { enabled: action.action === 'on' });
    const message = searchesMessage(await searches.list(this.owner));
    await this.telegram.editMessageText(this.settings.chatId, messageId, message.text, { keyboard: message.keyboard });
    await this.telegram.answerCallbackQuery(id, action.action === 'delete' ? 'Поиск удалён' : action.action === 'on' ? 'Поиск включён' : 'Поиск выключен');
  }

  /** Starts a task without waiting for it, so polling (and /stop) goes on; the report comes at the end. */
  private background(task: PipelineTask, trigger: TaskTrigger, options: TaskOptions, scheduleId: string | null): void {
    const job = (async () => {
      const outcome = await this.runner.run(task, trigger, options, scheduleId);
      if (shouldReport(outcome, this.settings.reportPolicy)) await this.say(await this.report(outcome));
      if (outcome.apply) await this.sendApply(outcome.apply);
    })().catch((error: unknown) => this.runtime.out.warn(`${task}: ${error instanceof Error ? error.message : error}`));
    const tracked = job.finally(() => { this.tasks.delete(tracked); });
    this.tasks.add(tracked);
  }

  // ── Applying ──

  /**
   * One message per form waiting for ✅ and per job to apply to by hand (with buttons), and per question
   * (its id is kept for the reply).
   */
  private async sendApply({ ready, questions, manual, submitted = [] }: ApplyMessages): Promise<void> {
    for (const sent of submitted) {
      await this.telegram.sendMessage(this.settings.chatId, submittedMessage(sent));
      if (!sent.screenshots.length) continue;
      const caption = `${escapeHtml(sent.application.jobTitle)} — ${escapeHtml(sent.application.company)}`;
      // The text already went out: a failed upload is only a warning.
      await this.telegram.sendPhotos(this.settings.chatId, sent.screenshots, caption).catch((error: unknown) => {
        this.runtime.out.warn(`скриншоты: ${error instanceof Error ? error.message : error}`);
        return this.say(escapeHtml(`Скриншоты не отправились: ${error instanceof Error ? error.message : error}`));
      });
    }
    for (const message of [...ready.map(readyMessage), ...manual.map(manualMessage)]) {
      await this.telegram.sendMessage(this.settings.chatId, message.text, { keyboard: message.keyboard });
    }
    for (const question of questions) {
      const messageId = await this.telegram.sendMessage(this.settings.chatId, questionMessage(question));
      await this.services.applications.setQuestionMessage(this.owner.id, question.id, String(messageId));
    }
  }

  /**
   * ✅ sends the form in the background (one task at a time; an external form is filled again first);
   * ❌ skips the job at once; «✅ подал сам» marks a `manual` job applied and Job-Tracker at once.
   */
  private async applicationButton(callbackId: string, messageId: number, action: ApplicationAction, applicationId: string): Promise<void> {
    const { applications } = this.services;
    if (action === 'reject') {
      const rejected = await applications.reject(this.owner.id, applicationId);
      await this.telegram.editMessageText(this.settings.chatId, messageId,
        `❌ Отклонено: ${escapeHtml(rejected.jobTitle)} — ${escapeHtml(rejected.company)}`);
      await this.telegram.answerCallbackQuery(callbackId, 'Отклонено');
      return;
    }
    if (action === 'appliedByHand') {
      const report = await applications.markManualApplied(this.owner.id, applicationId);
      await this.telegram.editMessageText(this.settings.chatId, messageId,
        `🖐 Подано вручную: ${escapeHtml(report.application.jobTitle)} — ${escapeHtml(report.application.company)}`);
      await this.telegram.answerCallbackQuery(callbackId, 'Отмечено');
      await this.say(submitResultText(report));
      return;
    }
    const busy = this.runner.busyText();
    if (busy) { await this.telegram.answerCallbackQuery(callbackId, `${busy}. Нажмите позже.`.slice(0, 190)); return; }
    // The attempt tells whether ✅ resumes Easy Apply or fills an external form again (minutes).
    const attempt = (await applications.pending(this.owner.id)).ready.find((item) => item.id === applicationId) ?? null;
    const job = attempt ? `${escapeHtml(attempt.jobTitle)} — ${escapeHtml(attempt.company)}` : '';
    if (attempt?.kind === 'external') {
      await this.telegram.answerCallbackQuery(callbackId, 'Заполняю заново и отправляю…');
      await this.telegram.editMessageText(this.settings.chatId, messageId,
        `⏳ Заполняю заново и отправляю: ${job}. Это пара минут, ход — /status; итог придёт сообщением.`);
    } else {
      await this.telegram.answerCallbackQuery(callbackId, 'Отправляю…');
      await this.telegram.editMessageText(this.settings.chatId, messageId, `⏳ Отправляю заявку${job ? `: ${job}` : ''}…`);
    }
    const run = (async () => {
      try {
        const run = await this.runner.exclusive(submitLabel(attempt), (signal) => applications.submit(this.owner.id, applicationId, signal));
        if (!run) { await this.say('Не отправлено: бот занят другой задачей. Повторите: /pending'); return; }
        await this.say(submitResultText(run.result));
      } catch (error) {
        const known = error instanceof ApplicationError || error instanceof BrowserBusyError;
        const message = error instanceof Error ? error.message : String(error);
        if (!known) this.runtime.out.warn(`submit: ${message}`);
        await this.say(escapeHtml(`Не отправлено: ${message}`));
      }
    })().catch((error: unknown) => this.runtime.out.warn(`submit: ${error instanceof Error ? error.message : error}`));
    const tracked = run.finally(() => { this.tasks.delete(tracked); });
    this.tasks.add(tracked);
  }

  /** A reply to a question message answers it; false when the replied message is not an open question. */
  private async replyToQuestion(messageId: number, text: string): Promise<boolean> {
    const { applications } = this.services;
    const question = await applications.findQuestionByMessage(this.owner.id, String(messageId));
    if (!question || question.status !== 'open') return false;
    const report = await applications.answerQuestion(this.owner.id, question.id, text, 'telegram');
    const busy = report.requeued ? this.runner.busyText() : null;
    const tail = !report.requeued
      ? `Осталось вопросов по этой вакансии: ${report.remaining}.`
      : busy
        ? `Все вопросы по вакансии закрыты: она снова в очереди (${busy}), следующий /run apply заполнит форму заново.`
        : 'Все вопросы по вакансии закрыты: заполняю форму заново по черновику и вашему ответу, итог придёт сообщением.';
    await this.say(`Записано в банк ответов:\n• ${escapeHtml(question.text)}\n  → ${escapeHtml(report.question.answer ?? text)}\n${tail}`);
    if (report.requeued && !busy) this.refill(question);
    return true;
  }

  /**
   * The last question of a job is answered: its form is filled again at once (with APPLY_AUTO_SUBMIT — and sent),
   * in the background under the "one task at a time" rule. Busy by then — the job stays queued for /run apply.
   */
  private refill(question: QuestionView): void {
    const { applications } = this.services;
    const label = `apply: ${question.jobTitle} — ${question.company} (после ответа)`;
    const run = (async () => {
      try {
        const run = await this.runner.exclusive(label, (signal) => applications.fillNext(this.owner.id, { jobId: question.jobId, signal }));
        if (!run) { await this.say('Бот занят другой задачей: вакансия в очереди, её заполнит следующий /run apply.'); return; }
        await this.say(`<b>apply</b> после ответа\n${applyReportLines(run.result).map(escapeHtml).join('\n')}`);
        await this.sendApply({ ready: run.result.ready, questions: run.result.questions, manual: run.result.manual, submitted: run.result.submitted });
      } catch (error) {
        const known = error instanceof ApplicationError || error instanceof BrowserBusyError;
        const message = error instanceof Error ? error.message : String(error);
        if (!known) this.runtime.out.warn(`apply после ответа: ${message}`);
        await this.say(escapeHtml(`Не заполнено заново: ${message}. Вакансия в очереди, её возьмёт /run apply.`));
      }
    })().catch((error: unknown) => this.runtime.out.warn(`apply после ответа: ${error instanceof Error ? error.message : error}`));
    const tracked = run.finally(() => { this.tasks.delete(tracked); });
    this.tasks.add(tracked);
  }

  private async report(outcome: TaskOutcome): Promise<string> {
    const top = outcome.queued > 0 ? (await this.services.jobs.list(this.owner, { status: 'queued', sort: 'score', limit: 5 })).items : [];
    return reportText(outcome, top);
  }

  private async say(text: string): Promise<void> {
    await this.telegram.sendMessage(this.settings.chatId, text);
  }

  /** A domain error is the user's mistake and is answered; anything else is logged and answered briefly. */
  private async guard(action: () => Promise<void>, callbackId?: string): Promise<void> {
    try {
      await action();
    } catch (error) {
      const known = error instanceof ApplicationError;
      const message = error instanceof Error ? error.message : String(error);
      if (!known) this.runtime.out.warn(`команда: ${message}`);
      try {
        if (callbackId) await this.telegram.answerCallbackQuery(callbackId, message.slice(0, 190));
        else await this.say(escapeHtml(known ? message : `Ошибка: ${message}`));
      } catch (reply) {
        this.runtime.out.warn(`Telegram: ${reply instanceof Error ? reply.message : reply}`);
      }
    }
  }
}
