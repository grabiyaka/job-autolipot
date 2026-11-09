import { ApplicationError } from '../../framework/core/errors.js';

/**
 * Pipeline tasks the bot runs now or on a schedule; apply fills forms and stops before Submit;
 * hunt collects from other job boards through the browser agent, then scores and sends like cycle.
 */
export const pipelineTasks = ['collect', 'score', 'cycle', 'apply', 'hunt'] as const;
export type PipelineTask = typeof pipelineTasks[number];

export const taskTriggers = ['manual', 'schedule'] as const;
export type TaskTrigger = typeof taskTriggers[number];

/** running → ok | error | aborted; busy — the run did not start (another task or the browser was busy). */
export const taskRunStatuses = ['running', 'ok', 'error', 'aborted', 'busy'] as const;
export type TaskRunStatus = typeof taskRunStatuses[number];

/** Time zone of a new schedule unless the owner names another one. */
export const DEFAULT_SCHEDULE_TIMEZONE = 'Europe/Dublin';
/** Default limit of one run, minutes (the same as --max-minutes of the CLI). */
export const DEFAULT_TASK_MINUTES = 60;
export const SUMMARY_MAX_LENGTH = 2000;

/** Task flags kept with a schedule or given to /run. Only the flags of that task are accepted. */
export type TaskOptions = Readonly<{
  /** No more than N jobs per owner when scoring; N agent runs when applying; N descriptions per search in hunt. */
  limit?: number;
  /** From which score a job goes to queued. */
  threshold?: number;
  /** Limit of the whole run, minutes. */
  maxMinutes?: number;
  /** Only LinkedIn Easy Apply jobs for this run. */
  easyApply?: boolean;
  /** Cycle without collecting: only scoring and sending. */
  skipCollect?: boolean;
}>;

const optionTasks: Record<keyof TaskOptions, readonly PipelineTask[]> = {
  limit: ['score', 'cycle', 'apply', 'hunt'],
  threshold: ['score', 'cycle', 'hunt'],
  maxMinutes: ['collect', 'score', 'cycle', 'apply', 'hunt'],
  easyApply: ['collect', 'cycle'],
  skipCollect: ['cycle'],
};

export function isPipelineTask(value: string): value is PipelineTask {
  return (pipelineTasks as readonly string[]).includes(value);
}

export function requireTask(value: string): PipelineTask {
  if (!isPipelineTask(value)) {
    throw new ApplicationError('INVALID_TASK', `Неизвестная задача «${value}»: ${pipelineTasks.join(', ')}.`, 400);
  }
  return value;
}

function integer(name: string, value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new ApplicationError('INVALID_OPTIONS', `${name} — целое число от ${min} до ${max}.`, 400);
  }
  return value;
}

function flag(name: string, value: unknown): boolean {
  if (typeof value !== 'boolean') throw new ApplicationError('INVALID_OPTIONS', `${name} — да или нет.`, 400);
  return value;
}

/** Checks the flags against the task and their ranges; unknown flags are refused. */
export function taskOptions(task: PipelineTask, input: Readonly<Record<string, unknown>>): TaskOptions {
  const options: { -readonly [K in keyof TaskOptions]: TaskOptions[K] } = {};
  for (const [name, value] of Object.entries(input)) {
    if (!(name in optionTasks)) throw new ApplicationError('INVALID_OPTIONS', `Неизвестный флаг «${name}».`, 400);
    const key = name as keyof TaskOptions;
    if (!optionTasks[key].includes(task)) {
      throw new ApplicationError('INVALID_OPTIONS', `Флаг «${name}» не относится к задаче ${task}.`, 400);
    }
    switch (key) {
      case 'limit': options.limit = integer('limit', value, 1, task === 'hunt' ? 50 : 10_000); break;
      case 'threshold': options.threshold = integer('threshold', value, 0, 100); break;
      case 'maxMinutes': options.maxMinutes = integer('maxMinutes', value, 1, 24 * 60); break;
      case 'easyApply': options.easyApply = flag('easyApply', value); break;
      case 'skipCollect': options.skipCollect = flag('skipCollect', value); break;
    }
  }
  return options;
}

/** Options as stored in the database; a broken value reads as "no options" rather than breaking the bot. */
export function storedOptions(task: PipelineTask, raw: string | null): TaskOptions {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? taskOptions(task, parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Five fields separated by single spaces, so "0  9 * * *" and "0 9 * * *" are one schedule. */
export function normalizeCron(cron: string): string {
  const fields = cron.trim().split(/\s+/).filter(Boolean);
  if (fields.length !== 5) {
    throw new ApplicationError('INVALID_CRON', 'Расписание — 5 полей cron: минута час день месяц день_недели, например «0 9,18 * * *».', 400);
  }
  return fields.join(' ');
}

export function summaryText(summary: string | null): string | null {
  if (summary === null) return null;
  return summary.length > SUMMARY_MAX_LENGTH ? `${summary.slice(0, SUMMARY_MAX_LENGTH - 1)}…` : summary;
}
