import type { PrismaClient, Schedule as ScheduleRecord, TaskRun as TaskRunRecord } from '../../generated/prisma/client.js';
import { storedOptions } from './ScheduleRules.js';
import type { PipelineTask } from './ScheduleRules.js';
import type { FinishedTaskRun, NewSchedule, NewTaskRun, Schedule, TaskRun } from './ScheduleService.js';

function toSchedule(record: ScheduleRecord): Schedule {
  return {
    id: record.id, task: record.task, cron: record.cron, timezone: record.timezone, enabled: record.enabled,
    options: storedOptions(record.task, record.options),
    lastRunAt: record.lastRunAt?.toISOString() ?? null, lastStatus: record.lastStatus, lastSummary: record.lastSummary,
    createdAt: record.createdAt.toISOString(), updatedAt: record.updatedAt.toISOString(),
  };
}

function toRun(record: TaskRunRecord): TaskRun {
  return {
    id: record.id, task: record.task, trigger: record.trigger, scheduleId: record.scheduleId,
    startedAt: record.startedAt.toISOString(), finishedAt: record.finishedAt?.toISOString() ?? null,
    status: record.status, summary: record.summary,
  };
}

const taskOrder: Record<PipelineTask, number> = { collect: 0, score: 1, cycle: 2, apply: 3 };

/** Schedules and task runs are always read and changed together with their owner. */
export class ScheduleRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async list(ownerId: string): Promise<Schedule[]> {
    const records = await this.prisma.schedule.findMany({ where: { userId: ownerId } });
    return records.map(toSchedule).sort((a, b) => taskOrder[a.task] - taskOrder[b.task]);
  }

  async find(ownerId: string, id: string): Promise<Schedule | null> {
    const record = await this.prisma.schedule.findFirst({ where: { id, userId: ownerId } });
    return record ? toSchedule(record) : null;
  }

  /** One schedule per task: a new one is created off, an existing one keeps `enabled`. */
  async upsert(ownerId: string, fields: NewSchedule): Promise<{ schedule: Schedule; created: boolean }> {
    const key = { userId_task: { userId: ownerId, task: fields.task } };
    const existed = await this.prisma.schedule.findUnique({ where: key, select: { id: true } });
    const data = { cron: fields.cron, timezone: fields.timezone, options: JSON.stringify(fields.options) };
    const record = await this.prisma.schedule.upsert({
      where: key,
      create: { userId: ownerId, task: fields.task, enabled: false, ...data },
      update: data,
    });
    return { schedule: toSchedule(record), created: !existed };
  }

  async setEnabledByTask(ownerId: string, task: PipelineTask, enabled: boolean): Promise<Schedule | null> {
    const { count } = await this.prisma.schedule.updateMany({ where: { userId: ownerId, task }, data: { enabled } });
    if (!count) return null;
    const record = await this.prisma.schedule.findUnique({ where: { userId_task: { userId: ownerId, task } } });
    return record ? toSchedule(record) : null;
  }

  async setEnabledById(ownerId: string, id: string, enabled: boolean): Promise<Schedule | null> {
    const { count } = await this.prisma.schedule.updateMany({ where: { id, userId: ownerId }, data: { enabled } });
    return count ? this.find(ownerId, id) : null;
  }

  async delete(ownerId: string, id: string): Promise<boolean> {
    const { count } = await this.prisma.schedule.deleteMany({ where: { id, userId: ownerId } });
    return count > 0;
  }

  async createRun(ownerId: string, run: NewTaskRun): Promise<TaskRun> {
    const record = await this.prisma.$transaction(async (tx) => {
      const created = await tx.taskRun.create({
        data: {
          userId: ownerId, task: run.task, trigger: run.trigger, scheduleId: run.scheduleId, startedAt: run.startedAt,
          status: run.status, finishedAt: run.finishedAt ?? null, summary: run.summary ?? null,
        },
      });
      if (run.scheduleId && run.status !== 'running') {
        await tx.schedule.updateMany({
          where: { id: run.scheduleId, userId: ownerId },
          data: { lastRunAt: run.startedAt, lastStatus: run.status, lastSummary: run.summary ?? null },
        });
      }
      return created;
    });
    return toRun(record);
  }

  async finishRun(ownerId: string, id: string, finished: FinishedTaskRun): Promise<TaskRun | null> {
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.taskRun.updateMany({ where: { id, userId: ownerId }, data: finished });
      if (!count) return null;
      const record = await tx.taskRun.findUniqueOrThrow({ where: { id } });
      if (record.scheduleId) {
        await tx.schedule.updateMany({
          where: { id: record.scheduleId, userId: ownerId },
          data: { lastRunAt: record.startedAt, lastStatus: finished.status, lastSummary: finished.summary },
        });
      }
      return toRun(record);
    });
  }

  async recentRuns(ownerId: string, limit: number): Promise<TaskRun[]> {
    const records = await this.prisma.taskRun.findMany({
      where: { userId: ownerId }, orderBy: [{ startedAt: 'desc' }, { id: 'desc' }], take: limit,
    });
    return records.map(toRun);
  }

  async failRunning(ownerId: string, now: Date, summary: string): Promise<number> {
    const { count } = await this.prisma.taskRun.updateMany({
      where: { userId: ownerId, status: 'running' }, data: { status: 'error', finishedAt: now, summary },
    });
    return count;
  }
}
