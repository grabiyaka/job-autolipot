import type { Actor } from '../../framework/core/actor.js';
import { ApplicationError } from '../../framework/core/errors.js';
import type { Clock } from '../../framework/core/runtime.js';
import type { CronCalendar } from './ScheduleTypes.js';
import type { ScheduleRepository } from './ScheduleRepository.js';
import { normalizeCron, requireTask, summaryText, taskOptions } from './ScheduleRules.js';
import type { PipelineTask, TaskOptions, TaskRunStatus, TaskTrigger } from './ScheduleRules.js';

export {
  DEFAULT_SCHEDULE_TIMEZONE, DEFAULT_TASK_MINUTES, isPipelineTask, pipelineTasks, taskOptions, taskRunStatuses, taskTriggers,
} from './ScheduleRules.js';
export type { PipelineTask, TaskOptions, TaskRunStatus, TaskTrigger } from './ScheduleRules.js';

export type Schedule = Readonly<{
  id: string;
  task: PipelineTask;
  cron: string;
  timezone: string;
  enabled: boolean;
  options: TaskOptions;
  lastRunAt: string | null;
  lastStatus: TaskRunStatus | null;
  lastSummary: string | null;
  createdAt: string;
  updatedAt: string;
}>;

/** A schedule with its next run from now; null when it is off or the expression never fires again. */
export type ScheduleView = Schedule & Readonly<{ nextRunAt: string | null }>;

export type TaskRun = Readonly<{
  id: string;
  task: PipelineTask;
  trigger: TaskTrigger;
  scheduleId: string | null;
  startedAt: string;
  finishedAt: string | null;
  status: TaskRunStatus;
  summary: string | null;
}>;

export type NewSchedule = Readonly<{ task: PipelineTask; cron: string; timezone: string; options: TaskOptions }>;
export type NewTaskRun = Readonly<{
  task: PipelineTask; trigger: TaskTrigger; scheduleId: string | null; startedAt: Date; status: TaskRunStatus;
  finishedAt?: Date; summary?: string | null;
}>;
export type FinishedTaskRun = Readonly<{ status: TaskRunStatus; finishedAt: Date; summary: string | null }>;

export type ScheduleSettings = Readonly<{ timezone: string }>;
export type SchedulePut = Readonly<{ task: string; cron: string; options?: Readonly<Record<string, unknown>>; timezone?: string }>;

/**
 * The owner's schedules (one per task) and the history of task runs. Every query is scoped to the owner;
 * another user's schedule behaves as missing. Running the task itself is not this domain's job.
 */
export class ScheduleService {
  constructor(
    private readonly schedules: ScheduleRepository,
    private readonly calendar: CronCalendar,
    private readonly clock: Clock,
    private readonly settings: ScheduleSettings,
  ) {}

  // ── Schedules ──

  async list(actor: Actor): Promise<ScheduleView[]> {
    const now = this.clock.now();
    return (await this.schedules.list(actor.id)).map((schedule) => this.view(schedule, now));
  }

  /**
   * Creates the task's schedule (switched off until the owner turns it on) or replaces its cron and
   * options; a replaced schedule keeps whether it was on.
   */
  async put(actor: Actor, input: SchedulePut): Promise<Readonly<{ schedule: ScheduleView; created: boolean }>> {
    const task = requireTask(input.task);
    const cron = normalizeCron(input.cron);
    const timezone = input.timezone?.trim() || this.settings.timezone;
    const problem = this.calendar.check(cron, timezone);
    if (problem) throw new ApplicationError('INVALID_CRON', problem, 400);
    const fields: NewSchedule = { task, cron, timezone, options: taskOptions(task, input.options ?? {}) };
    const { schedule, created } = await this.schedules.upsert(actor.id, fields);
    return { schedule: this.view(schedule, this.clock.now()), created };
  }

  async setEnabled(actor: Actor, task: string, enabled: boolean): Promise<ScheduleView> {
    const updated = await this.schedules.setEnabledByTask(actor.id, requireTask(task), enabled);
    if (!updated) throw new ApplicationError('SCHEDULE_NOT_FOUND', `Расписания для ${task} нет: создайте его командой /schedule ${task} <cron>.`, 404);
    return this.view(updated, this.clock.now());
  }

  async setEnabledById(actor: Actor, id: string, enabled: boolean): Promise<ScheduleView> {
    const updated = await this.schedules.setEnabledById(actor.id, id, enabled);
    if (!updated) throw this.notFound();
    return this.view(updated, this.clock.now());
  }

  async remove(actor: Actor, id: string): Promise<void> {
    if (!await this.schedules.delete(actor.id, id)) throw this.notFound();
  }

  /** The schedule as it is now; null when it was removed meanwhile. */
  find(actor: Actor, id: string): Promise<Schedule | null> {
    return this.schedules.find(actor.id, id);
  }

  /** The first run strictly after `after`; the scheduler counts from the time it planned, not from now. */
  nextRun(schedule: Schedule, after: Date): Date | null {
    return schedule.enabled ? this.calendar.next(schedule.cron, schedule.timezone, after) : null;
  }

  // ── Task runs ──

  async startRun(actor: Actor, task: PipelineTask, trigger: TaskTrigger, scheduleId: string | null): Promise<TaskRun> {
    return this.schedules.createRun(actor.id, { task, trigger, scheduleId, startedAt: this.clock.now(), status: 'running' });
  }

  /** Stores the result; a run from a schedule also becomes the schedule's last run. */
  async finishRun(actor: Actor, runId: string, status: Exclude<TaskRunStatus, 'running'>, summary: string | null): Promise<TaskRun> {
    const finished = await this.schedules.finishRun(actor.id, runId, { status, finishedAt: this.clock.now(), summary: summaryText(summary) });
    if (!finished) throw new ApplicationError('TASK_RUN_NOT_FOUND', 'Запуск не найден.', 404);
    return finished;
  }

  /** A run that could not start because something else was running; kept in the history all the same. */
  async recordBusy(actor: Actor, task: PipelineTask, trigger: TaskTrigger, scheduleId: string | null, summary: string): Promise<TaskRun> {
    const now = this.clock.now();
    return this.schedules.createRun(actor.id, {
      task, trigger, scheduleId, startedAt: now, finishedAt: now, status: 'busy', summary: summaryText(summary),
    });
  }

  recentRuns(actor: Actor, limit = 5): Promise<TaskRun[]> {
    return this.schedules.recentRuns(actor.id, limit);
  }

  /** Runs left `running` by a process that died are closed as errors when the bot starts again. */
  failInterrupted(actor: Actor): Promise<number> {
    return this.schedules.failRunning(actor.id, this.clock.now(), 'прервано: бот был остановлен во время задачи');
  }

  private view(schedule: Schedule, now: Date): ScheduleView {
    return { ...schedule, nextRunAt: this.nextRun(schedule, now)?.toISOString() ?? null };
  }

  private notFound(): ApplicationError {
    return new ApplicationError('SCHEDULE_NOT_FOUND', 'Расписание не найдено.', 404);
  }
}
