import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../framework/core/actor.js';
import { ApplicationError } from '../framework/core/errors.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { cronCalendar } from '../plugins/cron.js';
import { createPrismaClient } from '../plugins/database.js';
import { normalizeCron, storedOptions, taskOptions } from '../src/schedules/ScheduleRules.js';
import { ScheduleRepository } from '../src/schedules/ScheduleRepository.js';
import { ScheduleService } from '../src/schedules/ScheduleService.js';
import { createTestDatabase } from './auth-fixture.js';

const dublin = 'Europe/Dublin';
const at = (iso: string) => new Date(iso);

describe('cron calendar (croner) in Europe/Dublin', () => {
  it('keeps 9:00 local across the switch to winter time (25.10.2026)', () => {
    // Summer time (IST, UTC+1): 9:00 local is 08:00Z.
    expect(cronCalendar.next('0 9 * * *', dublin, at('2026-10-24T05:00:00Z'))).toEqual(at('2026-10-24T08:00:00Z'));
    // After the clocks go back on Sunday 25 October: 9:00 local is 09:00Z.
    expect(cronCalendar.next('0 9 * * *', dublin, at('2026-10-24T08:00:00Z'))).toEqual(at('2026-10-25T09:00:00Z'));
  });

  it('gives 9:00 and 18:00 in turn and is strictly after the given time', () => {
    const morning = cronCalendar.next('0 9,18 * * *', dublin, at('2026-11-04T08:59:00Z'))!;
    expect(morning).toEqual(at('2026-11-04T09:00:00Z'));
    const evening = cronCalendar.next('0 9,18 * * *', dublin, morning)!;
    expect(evening).toEqual(at('2026-11-04T18:00:00Z'));
    expect(cronCalendar.next('0 9,18 * * *', dublin, evening)).toEqual(at('2026-11-05T09:00:00Z'));
  });

  it('handles the switch to summer time (29.03.2026)', () => {
    expect(cronCalendar.next('0 9 * * *', dublin, at('2026-03-28T10:00:00Z'))).toEqual(at('2026-03-29T08:00:00Z'));
  });

  it('explains a wrong expression or time zone', () => {
    expect(cronCalendar.check('0 9 * * *', dublin)).toBeNull();
    expect(cronCalendar.check('0 25 * * *', dublin)).toMatch(/Неверное выражение cron/);
    expect(cronCalendar.check('0 9 * * *', 'Mars/Olympus')).toMatch(/часовой пояс/);
  });
});

describe('schedule rules', () => {
  it('normalizes five cron fields and refuses others', () => {
    expect(normalizeCron('  0  9,18 * * * ')).toBe('0 9,18 * * *');
    expect(() => normalizeCron('0 9 * *')).toThrow(ApplicationError);
    expect(() => normalizeCron('0 0 9 * * *')).toThrow(/5 полей/);
  });

  it('accepts only the flags of the task', () => {
    expect(taskOptions('cycle', { limit: 20, maxMinutes: 30, easyApply: true, skipCollect: false }))
      .toEqual({ limit: 20, maxMinutes: 30, easyApply: true, skipCollect: false });
    expect(() => taskOptions('collect', { limit: 5 })).toThrow(/не относится к задаче collect/);
    expect(() => taskOptions('score', { threshold: 101 })).toThrow(/от 0 до 100/);
    expect(() => taskOptions('score', { dryRun: true })).toThrow(/Неизвестный флаг/);
  });

  it('reads broken stored options as none', () => {
    expect(storedOptions('cycle', '{"limit":3}')).toEqual({ limit: 3 });
    expect(storedOptions('cycle', 'not json')).toEqual({});
    expect(storedOptions('collect', '{"limit":3}')).toEqual({});
  });
});

describe('ScheduleService on SQLite', () => {
  let testDatabase: ReturnType<typeof createTestDatabase>;
  let database: PrismaClient;
  let owner: Actor;
  let stranger: Actor;
  let now = at('2026-11-04T10:00:00Z');
  let service: ScheduleService;

  beforeAll(async () => {
    testDatabase = createTestDatabase();
    database = createPrismaClient(testDatabase.url);
    const create = (email: string) => database.user.create({ data: { email, name: email, passwordHash: 'x' } });
    owner = { id: (await create('owner@example.test')).id, role: 'user' };
    stranger = { id: (await create('stranger@example.test')).id, role: 'user' };
    service = new ScheduleService(new ScheduleRepository(database), cronCalendar, { now: () => now }, { timezone: dublin });
  }, 60_000);

  afterAll(async () => {
    await database?.$disconnect();
    testDatabase?.dispose();
  });

  beforeEach(async () => {
    now = at('2026-11-04T10:00:00Z');
    await database.taskRun.deleteMany({});
    await database.schedule.deleteMany({});
  });

  it('creates a schedule switched off, and a replacement keeps it on', async () => {
    const first = await service.put(owner, { task: 'cycle', cron: '0 9,18 * * *', options: { limit: 20 } });
    expect(first.created).toBe(true);
    expect(first.schedule).toMatchObject({ task: 'cycle', cron: '0 9,18 * * *', timezone: dublin, enabled: false, options: { limit: 20 }, nextRunAt: null });

    const on = await service.setEnabled(owner, 'cycle', true);
    expect(on.nextRunAt).toBe('2026-11-04T18:00:00.000Z');

    const replaced = await service.put(owner, { task: 'cycle', cron: '30 7 * * 1-5' });
    expect(replaced.created).toBe(false);
    expect(replaced.schedule).toMatchObject({ id: first.schedule.id, cron: '30 7 * * 1-5', enabled: true, options: {} });
    expect(replaced.schedule.nextRunAt).toBe('2026-11-05T07:30:00.000Z');
    expect(await service.list(owner)).toHaveLength(1);

    const off = await service.setEnabled(owner, 'cycle', false);
    expect(off).toMatchObject({ enabled: false, nextRunAt: null });
    expect(service.nextRun(off, now)).toBeNull();
  });

  it('refuses a wrong cron, task or time zone', async () => {
    await expect(service.put(owner, { task: 'cycle', cron: '0 25 * * *' })).rejects.toMatchObject({ code: 'INVALID_CRON' });
    await expect(service.put(owner, { task: 'autosubmit', cron: '0 9 * * *' })).rejects.toMatchObject({ code: 'INVALID_TASK' });
    await expect(service.put(owner, { task: 'score', cron: '0 9 * * *', timezone: 'Nowhere/City' })).rejects.toMatchObject({ code: 'INVALID_CRON' });
    await expect(service.setEnabled(owner, 'score', true)).rejects.toMatchObject({ code: 'SCHEDULE_NOT_FOUND', statusCode: 404 });
  });

  it("hides another owner's schedules", async () => {
    const { schedule } = await service.put(owner, { task: 'collect', cron: '0 9 * * *' });
    expect(await service.list(stranger)).toEqual([]);
    await expect(service.setEnabledById(stranger, schedule.id, true)).rejects.toMatchObject({ statusCode: 404 });
    await expect(service.remove(stranger, schedule.id)).rejects.toMatchObject({ statusCode: 404 });
    expect(await service.find(stranger, schedule.id)).toBeNull();
    await service.remove(owner, schedule.id);
    expect(await service.list(owner)).toEqual([]);
  });

  it('records runs, the last run of a schedule and busy attempts', async () => {
    const { schedule } = await service.put(owner, { task: 'cycle', cron: '0 9 * * *' });
    const run = await service.startRun(owner, 'cycle', 'schedule', schedule.id);
    expect(run).toMatchObject({ status: 'running', finishedAt: null, trigger: 'schedule' });
    now = at('2026-11-04T10:05:00Z');
    await service.finishRun(owner, run.id, 'ok', 'Итог цикла:\n  сбор: …');
    await service.recordBusy(owner, 'score', 'manual', null, 'занято: cycle, запущено 1 мин назад');

    const runs = await service.recentRuns(owner, 5);
    expect(runs.map((item) => [item.task, item.status])).toEqual([['score', 'busy'], ['cycle', 'ok']]);
    expect(runs[1]).toMatchObject({ finishedAt: '2026-11-04T10:05:00.000Z', summary: 'Итог цикла:\n  сбор: …' });
    const [stored] = await service.list(owner);
    expect(stored).toMatchObject({ lastRunAt: '2026-11-04T10:00:00.000Z', lastStatus: 'ok', lastSummary: 'Итог цикла:\n  сбор: …' });
    expect(await service.recentRuns(stranger)).toEqual([]);
    await expect(service.finishRun(stranger, run.id, 'error', null)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('closes runs left running by a stopped bot', async () => {
    await service.startRun(owner, 'collect', 'manual', null);
    await service.startRun(stranger, 'collect', 'manual', null);
    expect(await service.failInterrupted(owner)).toBe(1);
    expect((await service.recentRuns(owner))[0]).toMatchObject({ status: 'error', summary: expect.stringMatching(/прервано/) });
    expect((await service.recentRuns(stranger))[0]).toMatchObject({ status: 'running' });
  });

  it('keeps the run history when a schedule is removed', async () => {
    const { schedule } = await service.put(owner, { task: 'score', cron: '0 9 * * *' });
    const run = await service.startRun(owner, 'score', 'schedule', schedule.id);
    await service.remove(owner, schedule.id);
    await service.finishRun(owner, run.id, 'ok', null);
    expect((await service.recentRuns(owner))[0]).toMatchObject({ scheduleId: null, status: 'ok' });
  });
});
