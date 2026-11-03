import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../app.js';
import { createAuthFixture, testAuth, type AuthHeaders } from './auth-fixture.js';
import { PrismaReadingUnitOfWork } from '../framework/composition/prisma-reading-unit-of-work.js';
import { calculateWaterCharge } from '../src/readings/ReadingRules.js';
import type { ReadingCalculation, ReadingRecord, SubmitReadingResult } from '../src/readings/ReadingTypes.js';
import { PrismaClient } from '../generated/prisma/client.js';

// Explicit opt-in: never use DATABASE_URL or mutate a developer's normal demo account.
// Run migrations on a disposable PostgreSQL database before running this suite.
const databaseUrl = process.env.TEST_DATABASE_URL;
let operatorHeaders: AuthHeaders;
let subscriberHeaders: AuthHeaders;

describe.skipIf(!databaseUrl)('PostgreSQL: HTTP, транзакции и неизменяемая история', () => {
  let database: PrismaClient;
  let server: Awaited<ReturnType<typeof buildServer>>;
  let auth: Awaited<ReturnType<typeof createAuthFixture>>;

  beforeAll(async () => {
    if (!databaseUrl) throw new Error('TEST_DATABASE_URL must point to a disposable migrated database.');
    database = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
    await database.$connect();
    server = await buildServer({ databaseUrl, auth: testAuth, logger: false });
    auth = await createAuthFixture(server, database);
    operatorHeaders = auth.operatorHeaders;
    subscriberHeaders = auth.subscriberHeaders;
  }, 20_000);

  afterAll(async () => {
    await server?.close();
    await auth?.dispose();
    await database?.$disconnect();
  });

  async function createSubscriber() {
    const id = `test-${randomUUID()}`;
    return database.subscriber.create({
      data: {
        id, accountNumber: id, meterNumber: id,
        displayName: 'Синтетический тестовый абонент', villageName: 'Тестовое село',
        readingHundredths: 150_183, balanceKopeks: -5_000,
        waterTariffKopeks: 1_000, drainageTariffKopeks: 200,
        hasWater: true, hasDrainage: true,
      },
    });
  }

  function preview(subscriberId: string, reading = '1511.00') {
    return server.inject({
      method: 'POST', url: '/api/readings/preview', headers: operatorHeaders,
      payload: { subscriberId, reading },
    });
  }

  function submit(subscriberId: string, key = randomUUID(), reading = '1511.00', expectedVersion = 0) {
    return server.inject({
      method: 'POST', url: '/api/readings',
      headers: { ...operatorHeaders, 'idempotency-key': key },
      payload: { subscriberId, reading, expectedVersion },
    });
  }

  it('предварительный расчёт возвращает точные суммы и ничего не записывает', async () => {
    const before = await createSubscriber();
    const response = await preview(before.id);
    expect(response.statusCode).toBe(200);
    expect(response.json<{ calculation: ReadingCalculation }>().calculation).toMatchObject({
      previousReadingHundredths: 150_183, newReadingHundredths: 151_100,
      consumptionHundredths: 917, effectiveTariffKopeks: 1_200,
      chargeKopeks: 11_004, balanceBeforeKopeks: -5_000, balanceAfterKopeks: -16_004,
    });
    expect(await database.subscriber.findUnique({ where: { id: before.id } })).toEqual(before);
    expect(await database.reading.count({ where: { subscriberId: before.id } })).toBe(0);
  });

  it('сохраняет баланс, версию и полный снимок, воспроизводимый после изменения тарифа', async () => {
    const before = await createSubscriber();
    const key = randomUUID();
    const response = await submit(before.id, key, '1511,005');
    expect(response.statusCode).toBe(201);
    const result = response.json<SubmitReadingResult>();
    expect(result.replayed).toBe(false);
    expect(result.record).toMatchObject({
      idempotencyKey: key,
      originalInput: { subscriberId: before.id, reading: '1511,005', expectedVersion: 0 },
      actor: { id: auth.operator.id, role: 'manager' },
      subscriberBefore: before,
      calculation: { newReadingHundredths: 151_101, chargeKopeks: 11_016 },
    });
    expect(await database.subscriber.findUnique({ where: { id: before.id } })).toMatchObject({
      readingHundredths: 151_101, balanceKopeks: -16_016, version: 1,
    });
    await database.subscriber.update({ where: { id: before.id }, data: { waterTariffKopeks: 9_999 } });

    const history = await server.inject({
      method: 'GET', url: `/api/subscribers/${before.id}/readings`, headers: operatorHeaders,
    });
    expect(history.statusCode).toBe(200);
    expect(history.json<{ readings: ReadingRecord[] }>().readings).toEqual([result.record]);
    expect(calculateWaterCharge(result.record.subscriberBefore, result.record.originalInput.reading))
      .toEqual(result.record.calculation);
  });

  it('повторяет операцию с тем же ключом один раз и отклоняет изменение запроса', async () => {
    const before = await createSubscriber();
    const key = randomUUID();
    const first = await submit(before.id, key);
    const replay = await submit(before.id, key);
    expect([first.statusCode, replay.statusCode]).toEqual([201, 200]);
    expect(replay.json<SubmitReadingResult>()).toEqual({
      record: first.json<SubmitReadingResult>().record, replayed: true,
    });
    const conflict = await submit(before.id, key, '1512.00');
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_CONFLICT' } });
    expect(await database.reading.count({ where: { subscriberId: before.id } })).toBe(1);
    expect(await database.subscriber.findUnique({ where: { id: before.id } })).toMatchObject({ version: 1 });
  });

  it('шесть одновременных запросов с одним ключом создают ровно одно начисление', async () => {
    const before = await createSubscriber();
    const key = randomUUID();
    const responses = await Promise.all(Array.from({ length: 6 }, () => submit(before.id, key)));
    expect(responses.map(response => response.statusCode).sort()).toEqual([200, 200, 200, 200, 200, 201]);
    const records = responses.map(response => response.json<SubmitReadingResult>().record);
    expect(new Set(records.map(record => record.id)).size).toBe(1);
    expect(await database.reading.count({ where: { subscriberId: before.id } })).toBe(1);
    expect(await database.subscriber.findUnique({ where: { id: before.id } })).toMatchObject({
      readingHundredths: 151_100, balanceKopeks: -16_004, version: 1,
    });
  });

  it('из параллельных разных операций с одной версией сохраняется только одна', async () => {
    const before = await createSubscriber();
    const responses = await Promise.all([
      submit(before.id, randomUUID(), '1511.00'),
      submit(before.id, randomUUID(), '1512.00'),
    ]);
    expect(responses.map(response => response.statusCode).sort()).toEqual([201, 409]);
    const failed = responses.find(response => response.statusCode === 409);
    expect(failed?.json()).toMatchObject({ error: { code: 'STATE_CHANGED' } });
    const saved = responses.find(response => response.statusCode === 201)?.json<SubmitReadingResult>().record;
    expect(saved).toBeDefined();
    expect(await database.reading.count({ where: { subscriberId: before.id } })).toBe(1);
    expect(await database.subscriber.findUnique({ where: { id: before.id } })).toMatchObject({
      readingHundredths: saved?.calculation.newReadingHundredths,
      balanceKopeks: saved?.calculation.balanceAfterKopeks,
      version: 1,
    });
  });

  it('не сохраняет расчёт, если после предпросмотра версия абонента изменилась', async () => {
    const before = await createSubscriber();
    const calculation = (await preview(before.id)).json<{ calculation: ReadingCalculation }>().calculation;
    expect((await submit(before.id)).statusCode).toBe(201);
    const stale = await submit(before.id, randomUUID(), '1512.00', calculation.subscriberVersion);
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: { code: 'STATE_CHANGED' } });
    expect(await database.reading.count({ where: { subscriberId: before.id } })).toBe(1);
  });

  it.each(['1500.00', '1501.83'])('отклоняет меньшее или равное показание %s без изменений', async reading => {
    const before = await createSubscriber();
    const response = await submit(before.id, randomUUID(), reading);
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: { code: 'READING_MUST_INCREASE' } });
    expect(await database.subscriber.findUnique({ where: { id: before.id } })).toEqual(before);
    expect(await database.reading.count({ where: { subscriberId: before.id } })).toBe(0);
  });

  it('проверяет авторизацию, роль оператора и владение абонентом', async () => {
    const before = await createSubscriber();
    const anonymous = await server.inject({ method: 'GET', url: '/api/subscribers' });
    expect(anonymous.statusCode).toBe(401);
    const restricted = await server.inject({
      method: 'GET', url: '/api/operator/status', headers: subscriberHeaders,
    });
    expect(restricted.statusCode).toBe(403);
    const allowed = await server.inject({
      method: 'GET', url: '/api/operator/status', headers: operatorHeaders,
    });
    expect(allowed.statusCode).toBe(200);
    const foreignAccountResponses = await Promise.all([
      server.inject({
        method: 'POST', url: '/api/readings/preview', headers: subscriberHeaders,
        payload: { subscriberId: before.id, reading: '1511.00' },
      }),
      server.inject({
        method: 'POST', url: '/api/readings',
        headers: { ...subscriberHeaders, 'idempotency-key': randomUUID() },
        payload: { subscriberId: before.id, reading: '1511.00', expectedVersion: 0 },
      }),
      server.inject({
        method: 'GET', url: `/api/subscribers/${before.id}/readings`, headers: subscriberHeaders,
      }),
    ]);
    for (const response of foreignAccountResponses) {
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: 'ACCESS_DENIED' } });
    }
    expect(await database.reading.count({ where: { subscriberId: before.id } })).toBe(0);
  });

  it('отклоняет лишние поля и числовое показание вместо десятичной строки', async () => {
    const before = await createSubscriber();
    for (const payload of [
      { subscriberId: before.id, reading: '1511.00', balanceKopeks: 1_000_000 },
      { subscriberId: before.id, reading: 1511 },
    ]) {
      const response = await server.inject({
        method: 'POST', url: '/api/readings/preview', headers: operatorHeaders, payload,
      });
      expect(response.statusCode).toBe(400);
    }
    expect(await database.subscriber.findUnique({ where: { id: before.id } })).toEqual(before);
  });

  it('откатывает баланс и показание, если вставка истории нарушила уникальность', async () => {
    const donor = await createSubscriber();
    const first = await submit(donor.id);
    expect(first.statusCode).toBe(201);
    const occupiedRecord = first.json<SubmitReadingResult>().record;
    const before = await createSubscriber();
    const calculation = calculateWaterCharge(before, '1511.00');
    const operation = new PrismaReadingUnitOfWork(database, { now: () => new Date() }, { next: randomUUID }).run(async ({ subscribers, readings }) => {
      await subscribers.applyMeterReading({
        subscriberId: before.id, expectedVersion: before.version,
        readingHundredths: calculation.newReadingHundredths,
        balanceKopeks: calculation.balanceAfterKopeks,
      });
      await readings.save({
        ...occupiedRecord,
        idempotencyKey: randomUUID(),
        originalInput: { subscriberId: before.id, reading: '1511.00', expectedVersion: before.version },
        subscriberBefore: before,
        calculation,
      });
    });
    await expect(operation).rejects.toMatchObject({ code: 'P2002' });
    expect(await database.subscriber.findUnique({ where: { id: before.id } })).toEqual(before);
    expect(await database.reading.count({ where: { subscriberId: before.id } })).toBe(0);
  });

  it('PostgreSQL запрещает изменение и удаление сохранённой истории', async () => {
    const before = await createSubscriber();
    const response = await submit(before.id);
    expect(response.statusCode).toBe(201);
    const record = response.json<SubmitReadingResult>().record;
    await expect(database.reading.update({
      where: { id: record.id }, data: { idempotencyKey: randomUUID() },
    })).rejects.toThrow(/append-only/);
    await expect(database.reading.delete({ where: { id: record.id } })).rejects.toThrow(/append-only/);
    const persisted = await database.reading.findUnique({ where: { id: record.id } });
    expect(persisted?.snapshot).toEqual(record);
    expect(persisted?.idempotencyKey).toBe(record.idempotencyKey);
  });
});
