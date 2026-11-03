import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../app.js';
import { createAuthFixture, testAuth, type AuthHeaders } from './auth-fixture.js';
import { createApplication } from '../framework/composition/create-application.js';
import type { Actor } from '../framework/core/actor.js';
import { PrismaClient } from '../generated/prisma/client.js';
import type { SubmitReadingResult } from '../src/readings/ReadingTypes.js';
import type { SubscriberSnapshot } from '../src/subscribers/SubscriberTypes.js';
import type {
  CreateTransactionInput, TransactionEffect, TransactionPage, TransactionResult, TransactionView,
} from '../src/transactions/TransactionTypes.js';

// Explicit opt-in, isolated generated accounts: never use DATABASE_URL or mutate seeded demo accounts.
const databaseUrl = process.env.TEST_DATABASE_URL;
let operatorHeaders: AuthHeaders;
let subscriberHeaders: AuthHeaders;
const operator: Actor = { id: 'test-transaction-operator', role: 'manager' };

describe.skipIf(!databaseUrl)('PostgreSQL: операции Водогона и неизменяемый журнал', () => {
  let database: PrismaClient;
  let server: Awaited<ReturnType<typeof buildServer>>;
  let auth: Awaited<ReturnType<typeof createAuthFixture>>;
  let application: ReturnType<typeof createApplication>;

  beforeAll(async () => {
    if (!databaseUrl) throw new Error('TEST_DATABASE_URL must point to a disposable migrated database.');
    database = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
    await database.$connect();
    server = await buildServer({ databaseUrl, auth: testAuth, logger: false });
    auth = await createAuthFixture(server, database);
    operatorHeaders = auth.operatorHeaders;
    subscriberHeaders = auth.subscriberHeaders;
    application = createApplication(database, { now: () => new Date() }, { next: randomUUID });
  }, 20_000);

  afterAll(async () => {
    await server?.close();
    await auth?.dispose();
    await database?.$disconnect();
  });

  async function createSubscriber(overrides: Partial<Pick<SubscriberSnapshot,
    'readingHundredths' | 'balanceKopeks' | 'maintenanceBalanceKopeks' | 'hasWater' | 'hasDrainage'
  >> = {}) {
    const id = `transaction-test-${randomUUID()}`;
    return database.subscriber.create({
      data: {
        id, accountNumber: id, meterNumber: id,
        displayName: 'Тестовый абонент журнала', villageName: 'Синтетическое село',
        readingHundredths: 2_000, balanceKopeks: -10_000, maintenanceBalanceKopeks: -1_500,
        waterTariffKopeks: 1_000, drainageTariffKopeks: 200,
        hasWater: true, hasDrainage: true,
        ...overrides,
      },
    });
  }

  function payment(subscriberId: string, expectedVersion = 0, amount = '40.00'): CreateTransactionInput {
    return { kind: 'payment', subscriberId, expectedVersion, amount, method: 'cash' };
  }

  function submit(input: CreateTransactionInput, key = randomUUID()) {
    return server.inject({
      method: 'POST', url: '/api/transactions',
      headers: { ...operatorHeaders, 'idempotency-key': key }, payload: input,
    });
  }

  async function save(input: CreateTransactionInput, key = randomUUID()) {
    const response = await submit(input, key);
    expect(response.statusCode, response.body).toBe(201);
    return response.json<TransactionResult>().record;
  }

  function cancel(id: string, expectedVersion: number, key = randomUUID()) {
    return server.inject({
      method: 'POST', url: `/api/transactions/${id}/cancel`,
      headers: { ...operatorHeaders, 'idempotency-key': key },
      payload: { expectedVersion, reason: 'Исправление ошибочной операции' },
    });
  }

  async function view(id: string) {
    const response = await server.inject({ method: 'GET', url: `/api/transactions/${id}`, headers: operatorHeaders });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<{ transaction: TransactionView }>().transaction;
  }

  it('предпросмотр распределяет каждую копейку сначала на обслуживание и ничего не записывает', async () => {
    const before = await createSubscriber();
    const response = await server.inject({
      method: 'POST', url: '/api/transactions/preview', headers: operatorHeaders,
      payload: payment(before.id, 0, '40.01'),
    });
    expect(response.statusCode, response.body).toBe(200);
    const { effect } = response.json<{ effect: TransactionEffect }>();
    expect(effect).toMatchObject({
      kind: 'payment', category: 'cash',
      payment: { amountKopeks: 4_001, maintenanceKopeks: 1_500, waterKopeks: 2_501 },
      change: { balanceKopeks: 2_501, maintenanceBalanceKopeks: 1_500, readingHundredths: 0 },
      after: { balanceKopeks: -7_499, maintenanceBalanceKopeks: 0, readingHundredths: 2_000 },
    });
    expect(effect.payment!.waterKopeks + effect.payment!.maintenanceKopeks).toBe(effect.payment!.amountKopeks);
    expect(await database.subscriber.findUnique({ where: { id: before.id } })).toEqual(before);
    expect(await database.ledgerTransaction.count({ where: { subscriberId: before.id } })).toBe(0);
  });

  it('сохраняет исходный банковский запрос, тарифы, автора и распределение после изменения карточки', async () => {
    const before = await createSubscriber({ maintenanceBalanceKopeks: -2_003 });
    const input: CreateTransactionInput = {
      kind: 'payment', subscriberId: before.id, expectedVersion: 0, amount: '99,99', method: 'bank',
      externalReference: `bank-${randomUUID()}`, purpose: 'Оплата воды и обслуживания',
    };
    const record = await save(input);
    expect(record).toMatchObject({
      subscriberId: before.id, actor: { id: auth.operator.id, role: 'manager' },
      request: { action: 'create', input }, subscriberBefore: before,
      effect: {
        payment: { amountKopeks: 9_999, maintenanceKopeks: 2_003, waterKopeks: 7_996 },
        tariff: { waterKopeks: 1_000, drainageKopeks: 200, effectiveKopeks: 1_200, hasWater: true, hasDrainage: true },
      },
    });
    expect(await database.subscriber.findUnique({ where: { id: before.id } })).toMatchObject({
      balanceKopeks: -2_004, maintenanceBalanceKopeks: 0, readingHundredths: 2_000, version: 1,
    });
    await database.subscriber.update({
      where: { id: before.id }, data: { waterTariffKopeks: 9_999, hasDrainage: false, displayName: 'Новое имя' },
    });
    expect((await view(record.id)).record).toEqual(record);
  });

  it('HTTP читает точные исходные данные операций, вызванных другим доменом через типизированный API', async () => {
    const paymentSubscriber = await createSubscriber();
    const input: CreateTransactionInput = {
      kind: 'payment', subscriberId: paymentSubscriber.id, expectedVersion: 0,
      amount: ' 40.00 ', method: 'bank', externalReference: 'b'.repeat(201), purpose: 'п'.repeat(1_001),
    };
    const paymentResult = await application.transactions.create(input, operator, randomUUID());
    expect(paymentResult.record.request).toEqual({ action: 'create', input });
    expect((await view(paymentResult.record.id)).record).toEqual(paymentResult.record);
    const listResponse = await server.inject({
      method: 'GET', url: `/api/transactions?subscriberId=${paymentSubscriber.id}`, headers: operatorHeaders,
    });
    expect(listResponse.statusCode, listResponse.body).toBe(200);
    expect(listResponse.json<TransactionPage>().items[0]?.record).toEqual(paymentResult.record);

    const readingSubscriber = await createSubscriber();
    const readingInput = { subscriberId: readingSubscriber.id, expectedVersion: 0, reading: ' 25.00 ' };
    const readingResult = await application.readings.submit(readingInput, operator, randomUUID());
    expect(readingResult.record.originalInput).toEqual(readingInput);
    const historyResponse = await server.inject({
      method: 'GET', url: `/api/subscribers/${readingSubscriber.id}/readings`, headers: operatorHeaders,
    });
    expect(historyResponse.statusCode, historyResponse.body).toBe(200);
    expect(historyResponse.json().readings).toEqual([readingResult.record]);
    const ledgerView = await view(readingResult.record.id);
    expect(ledgerView.record.request).toEqual({ action: 'reading-demo', reading: readingResult.record });
  });

  it('отклоняет отрицательные, нулевые и дробные до долей копейки платежи без изменения состояния', async () => {
    const before = await createSubscriber();
    for (const amount of ['-1.00', '0.00', '0.001', '1.001']) {
      const response = await submit(payment(before.id, 0, amount));
      expect(response.statusCode, response.body).toBe(amount.startsWith('-') ? 400 : 422);
    }
    expect(await database.subscriber.findUnique({ where: { id: before.id } })).toEqual(before);
    expect(await database.ledgerTransaction.count({ where: { subscriberId: before.id } })).toBe(0);
  });

  it('оператор может уменьшить показание и вернуть стоимость отрицательного расхода', async () => {
    const before = await createSubscriber();
    const record = await save({ kind: 'reading', subscriberId: before.id, expectedVersion: 0, reading: '18.00' });
    expect(record.effect).toMatchObject({
      category: 'recalculation',
      change: { balanceKopeks: 2_400, maintenanceBalanceKopeks: 0, readingHundredths: -200 },
      after: { balanceKopeks: -7_600, maintenanceBalanceKopeks: -1_500, readingHundredths: 1_800 },
    });
    expect(await database.subscriber.findUnique({ where: { id: before.id } })).toMatchObject({
      balanceKopeks: -7_600, readingHundredths: 1_800, version: 1,
    });
  });

  it('абонент передаёт только растущее собственное показание и не подтверждает его как оператор', async () => {
    const before = await createSubscriber();
    const actor: Actor = { id: randomUUID(), role: 'guest', subscriberId: before.id };
    for (const reading of ['18.00', '20.00']) {
      await expect(application.transactions.create({
        kind: 'reading', subscriberId: before.id, expectedVersion: 0, reading,
      }, actor, randomUUID())).rejects.toMatchObject({ statusCode: 422 });
    }
    await expect(application.transactions.create({
      kind: 'reading', subscriberId: before.id, expectedVersion: 0, reading: '25.00', verified: true,
    }, actor, randomUUID())).rejects.toMatchObject({ statusCode: 403 });
    await expect(application.transactions.create(payment(before.id), actor, randomUUID()))
      .rejects.toMatchObject({ statusCode: 403 });
    expect(await database.subscriber.findUnique({ where: { id: before.id } })).toEqual(before);
    const result = await application.transactions.create({
      kind: 'reading', subscriberId: before.id, expectedVersion: 0, reading: '25.00',
    }, actor, randomUUID());
    expect(result.record.effect).toMatchObject({ confirmsReading: false, change: { balanceKopeks: -6_000, readingHundredths: 500 } });
    expect(await database.subscriber.findUnique({ where: { id: before.id } })).toMatchObject({
      readingHundredths: 2_500, balanceKopeks: -16_000, verifiedReadingHundredths: null,
    });
  });

  it('сверка устанавливает все три абсолютных значения и фиксирует подтверждённое показание', async () => {
    const before = await createSubscriber();
    const input: CreateTransactionInput = {
      kind: 'reconciliation', subscriberId: before.id, expectedVersion: 0,
      reading: '10.00', balance: '8.12', maintenanceBalance: '-3.45', reason: 'Сверка с актом',
    };
    const record = await save(input);
    expect(record.effect).toMatchObject({
      kind: 'meter-reconciliation', confirmsReading: true,
      change: { balanceKopeks: 10_812, maintenanceBalanceKopeks: 1_155, readingHundredths: -1_000 },
      after: { balanceKopeks: 812, maintenanceBalanceKopeks: -345, readingHundredths: 1_000 },
    });
    expect(record.request).toEqual({ action: 'create', input });
    expect(await database.subscriber.findUnique({ where: { id: before.id } })).toMatchObject({
      balanceKopeks: 812, maintenanceBalanceKopeks: -345, readingHundredths: 1_000,
      verifiedReadingHundredths: 1_000, verifiedByTransactionId: record.id, version: 1,
    });
  });

  it('отмена старого платежа сохраняет поздний платёж и первоначальные снимки цепочки', async () => {
    const before = await createSubscriber();
    const first = await save(payment(before.id));
    const second = await save(payment(before.id, 1, '10.00'));
    const response = await cancel(first.id, 2);
    expect(response.statusCode, response.body).toBe(201);
    const cancellation = response.json<TransactionResult>().record;
    expect(cancellation).toMatchObject({
      reversesId: first.id,
      effect: { kind: 'cancellation', change: { balanceKopeks: -2_500, maintenanceBalanceKopeks: -1_500, readingHundredths: 0 } },
    });
    expect(await database.subscriber.findUnique({ where: { id: before.id } })).toMatchObject({
      balanceKopeks: -9_000, maintenanceBalanceKopeks: -1_500, readingHundredths: 2_000, version: 3,
    });
    const firstView = await view(first.id);
    const secondView = await view(second.id);
    expect(firstView.record).toEqual(first);
    expect(firstView.cancelledBy).toBe(cancellation.id);
    expect(secondView.record).toEqual(second);
    expect(secondView.projection).toEqual({
      before: { balanceKopeks: -10_000, maintenanceBalanceKopeks: -1_500, readingHundredths: 2_000 },
      after: { balanceKopeks: -9_000, maintenanceBalanceKopeks: -1_500, readingHundredths: 2_000 },
    });
  });

  it('отмена подтверждения восстанавливает предыдущую сверку и сохраняет более позднее обычное показание', async () => {
    const before = await createSubscriber();
    const first = await save({ kind: 'reading', subscriberId: before.id, expectedVersion: 0, reading: '25', verified: true });
    const second = await save({ kind: 'reading', subscriberId: before.id, expectedVersion: 1, reading: '30', verified: true });
    const third = await save({ kind: 'reading', subscriberId: before.id, expectedVersion: 2, reading: '31' });
    const response = await cancel(second.id, 3);
    expect(response.statusCode, response.body).toBe(201);
    expect(await database.subscriber.findUnique({ where: { id: before.id } })).toMatchObject({
      readingHundredths: 2_600, balanceKopeks: -17_200, version: 4,
      verifiedReadingHundredths: 2_500, verifiedByTransactionId: first.id,
    });
    expect((await view(second.id)).record).toEqual(second);
    expect((await view(third.id)).record).toEqual(third);
    expect(response.json<TransactionResult>().record.verificationAfter).toEqual(first.verificationAfter);
  });

  it('повтор отмены с тем же ключом безопасен, новая отмена и отмена самой отмены запрещены', async () => {
    const before = await createSubscriber();
    const record = await save(payment(before.id));
    const key = randomUUID();
    const first = await cancel(record.id, 1, key);
    const replay = await cancel(record.id, 1, key);
    expect([first.statusCode, replay.statusCode]).toEqual([201, 200]);
    const saved = first.json<TransactionResult>().record;
    expect(replay.json<TransactionResult>()).toEqual({ record: saved, replayed: true });
    expect((await cancel(record.id, 2)).statusCode).toBe(409);
    expect((await cancel(saved.id, 2)).statusCode).toBe(409);
    expect(await database.subscriber.findUnique({ where: { id: before.id } })).toMatchObject({
      balanceKopeks: before.balanceKopeks, maintenanceBalanceKopeks: before.maintenanceBalanceKopeks,
      readingHundredths: before.readingHundredths, version: 2,
    });
  });

  it('правка описания создаёт отдельное доказательство и не изменяет финансовый эффект исходной записи', async () => {
    const before = await createSubscriber();
    const record = await save(payment(before.id));
    const key = randomUUID();
    const request = {
      method: 'PATCH' as const, url: `/api/transactions/${record.id}/description`,
      headers: { ...operatorHeaders, 'idempotency-key': key },
      payload: { expectedVersion: 1, description: 'Уточнение назначения', reason: 'Опечатка в квитанции' },
    };
    const response = await server.inject(request);
    expect(response.statusCode, response.body).toBe(201);
    const amendment = response.json<TransactionResult>().record;
    expect(amendment).toMatchObject({
      amendsId: record.id, request: { action: 'amend', transactionId: record.id, input: request.payload },
      effect: { kind: 'description-change', change: { balanceKopeks: 0, maintenanceBalanceKopeks: 0, readingHundredths: 0 } },
    });
    expect(await view(record.id)).toMatchObject({ record, description: request.payload.description, cancelledBy: null });
    expect(await database.subscriber.findUnique({ where: { id: before.id } })).toMatchObject({
      balanceKopeks: -7_500, maintenanceBalanceKopeks: 0, readingHundredths: 2_000, version: 2,
    });
    const replay = await server.inject(request);
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json<TransactionResult>()).toEqual({ record: amendment, replayed: true });
  });

  it('PostgreSQL запрещает физическое изменение и удаление журнала', async () => {
    const before = await createSubscriber();
    const record = await save(payment(before.id));
    await expect(database.ledgerTransaction.update({
      where: { id: record.id }, data: { idempotencyKey: randomUUID() },
    })).rejects.toThrow(/append-only/);
    await expect(database.ledgerTransaction.delete({ where: { id: record.id } })).rejects.toThrow(/append-only/);
    expect((await view(record.id)).record).toEqual(record);
  });

  it('ошибка вставки журнала откатывает балансы, показание, подтверждение и версию карточки', async () => {
    const donor = await createSubscriber();
    const occupiedRecord = await save(payment(donor.id));
    const before = await createSubscriber();
    const duplicateIdentifiers = createApplication(database, { now: () => new Date() }, {
      next: () => occupiedRecord.id,
    });
    const key = randomUUID();
    const input: CreateTransactionInput = {
      kind: 'reconciliation', subscriberId: before.id, expectedVersion: 0,
      reading: '25.00', balance: '123.45', maintenanceBalance: '67.89', reason: 'Проверка полного отката',
    };
    await expect(duplicateIdentifiers.transactions.create(input, operator, key))
      .rejects.toMatchObject({ code: 'STATE_CHANGED', statusCode: 409 });
    expect(await database.subscriber.findUnique({ where: { id: before.id } })).toEqual(before);
    expect(await database.ledgerTransaction.count({ where: { subscriberId: before.id } })).toBe(0);
    expect((await view(occupiedRecord.id)).record).toEqual(occupiedRecord);

    const retry = await application.transactions.create(input, operator, key);
    expect(retry.replayed).toBe(false);
    expect(await database.subscriber.findUnique({ where: { id: before.id } })).toMatchObject({
      balanceKopeks: 12_345, maintenanceBalanceKopeks: 6_789, readingHundredths: 2_500,
      verifiedReadingHundredths: 2_500, verifiedByTransactionId: retry.record.id, version: 1,
    });
  });

  it('шесть одновременных повторов создают один платёж, а подмена запроса с этим ключом отклоняется', async () => {
    const before = await createSubscriber();
    const key = randomUUID();
    const responses = await Promise.all(Array.from({ length: 6 }, () => submit(payment(before.id), key)));
    expect(responses.map(response => response.statusCode).sort()).toEqual([200, 200, 200, 200, 200, 201]);
    expect(new Set(responses.map(response => response.json<TransactionResult>().record.id)).size).toBe(1);
    const conflict = await submit(payment(before.id, 0, '41.00'), key);
    expect(conflict.statusCode, conflict.body).toBe(409);
    expect(conflict.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_CONFLICT' } });
    expect(await database.ledgerTransaction.count({ where: { subscriberId: before.id } })).toBe(1);
    expect(await database.subscriber.findUnique({ where: { id: before.id } })).toMatchObject({
      balanceKopeks: -7_500, maintenanceBalanceKopeks: 0, version: 1,
    });
  });

  it('из разных конкурентных команд с одной версией только одна меняет карточку', async () => {
    const before = await createSubscriber();
    const responses = await Promise.all([submit(payment(before.id)), submit(payment(before.id, 0, '55.00'))]);
    expect(responses.map(response => response.statusCode).sort()).toEqual([201, 409]);
    expect(responses.find(response => response.statusCode === 409)?.json())
      .toMatchObject({ error: { code: 'STATE_CHANGED' } });
    const saved = responses.find(response => response.statusCode === 201)!.json<TransactionResult>().record;
    expect(await database.subscriber.findUnique({ where: { id: before.id } })).toMatchObject({ ...saved.effect.after, version: 1 });
    expect(await database.ledgerTransaction.count({ where: { subscriberId: before.id } })).toBe(1);
  });

  it('повторный банковский идентификатор не зачисляется под новым ключом операции', async () => {
    const before = await createSubscriber();
    const externalReference = `bank-import-${randomUUID()}`;
    const input: CreateTransactionInput = {
      kind: 'payment', subscriberId: before.id, expectedVersion: 0,
      amount: '40.00', method: 'bank', externalReference,
    };
    const saved = await save(input);
    const duplicate = await submit({ ...input, expectedVersion: 1 });
    expect(duplicate.statusCode, duplicate.body).toBe(409);
    expect(await database.ledgerTransaction.count({ where: { subscriberId: before.id } })).toBe(1);
    expect(await database.subscriber.findUnique({ where: { id: before.id } })).toMatchObject({ ...saved.effect.after, version: 1 });
  });

  it('HTTP требует авторизацию и запрещает абоненту финансовые операции и чужие записи', async () => {
    const before = await createSubscriber();
    const record = await save(payment(before.id));
    expect((await server.inject({ method: 'GET', url: '/api/transactions' })).statusCode).toBe(401);
    const requests = [
      { method: 'GET' as const, url: `/api/transactions/${record.id}` },
      { method: 'GET' as const, url: `/api/transactions?subscriberId=${before.id}` },
      { method: 'GET' as const, url: `/api/transactions/export.csv?subscriberId=${before.id}` },
      { method: 'POST' as const, url: '/api/transactions', payload: payment(before.id, 1) },
      { method: 'POST' as const, url: `/api/transactions/${record.id}/cancel`, payload: { expectedVersion: 1, reason: 'Подмена' } },
      { method: 'PATCH' as const, url: `/api/transactions/${record.id}/description`, payload: { expectedVersion: 1, description: 'Подмена', reason: 'Подмена' } },
    ];
    for (const request of requests) {
      const response = await server.inject({ ...request, headers: { ...subscriberHeaders, 'idempotency-key': randomUUID() } });
      expect(response.statusCode, response.body).toBe(403);
    }
    expect(await database.subscriber.findUnique({ where: { id: before.id } })).toMatchObject({ version: 1 });
  });

  it('абонент видит собственный список и записи, а выгрузка CSV доступна только оператору', async () => {
    const own = await createSubscriber();
    const foreign = await createSubscriber();
    const ownRecord = await save(payment(own.id));
    const foreignRecord = await save(payment(foreign.id));
    const actor: Actor = { id: randomUUID(), role: 'guest', subscriberId: own.id };
    const page = await application.transactions.list({}, actor);
    expect(page.total).toBe(1);
    expect(page.items.map(item => item.record.id)).toEqual([ownRecord.id]);
    expect((await application.transactions.getById(ownRecord.id, actor)).record).toEqual(ownRecord);
    await expect(application.transactions.getById(foreignRecord.id, actor)).rejects.toMatchObject({ statusCode: 403 });
    await expect(application.transactions.list({ subscriberId: foreign.id }, actor)).rejects.toMatchObject({ statusCode: 403 });
    await expect(application.transactions.exportCsv({}, actor)).rejects.toMatchObject({ statusCode: 403 });
    await expect(application.transactions.cancel(ownRecord.id, { expectedVersion: 1, reason: 'Нельзя' }, actor, randomUUID()))
      .rejects.toMatchObject({ statusCode: 403 });
  });

  it('фильтры и страницы сохраняют устойчивую последовательность при одинаковом времени записи', async () => {
    const before = await createSubscriber();
    const fixedTime = '2026-02-03T12:34:56.000Z';
    const fixedApplication = createApplication(database, { now: () => new Date(fixedTime) }, { next: randomUUID });
    const first = await fixedApplication.transactions.create(payment(before.id), operator, randomUUID());
    await fixedApplication.transactions.create({
      kind: 'note', subscriberId: before.id, expectedVersion: 1, description: 'Не является платежом',
    }, operator, randomUUID());
    const second = await fixedApplication.transactions.create(payment(before.id, 2, '5.00'), operator, randomUUID());
    const response = await server.inject({
      method: 'GET', headers: operatorHeaders,
      url: `/api/transactions?subscriberId=${before.id}&kind=payment&from=2026-02-03&to=2026-02-03&order=asc&page=1&limit=1`,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<TransactionPage>()).toMatchObject({ total: 2, page: 1, limit: 1, items: [{ record: second.record }] });
    const matching = await application.transactions.list({ subscriberId: before.id, order: 'asc' }, operator);
    expect(matching.items[0]?.record.id).toBe(first.record.id);
    expect(matching.items[2]?.record.id).toBe(second.record.id);
    expect(first.record.sequence).toBeLessThan(second.record.sequence);
    const invalidRange = await server.inject({
      method: 'GET', url: '/api/transactions?from=2026-02-04&to=2026-02-03', headers: operatorHeaders,
    });
    expect(invalidRange.statusCode, invalidRange.body).toBe(400);
  });

  it('CSV учитывает фильтры, выгружает все выбранные страницы и экранирует формулы и кавычки', async () => {
    const before = await createSubscriber();
    const first = await save({
      kind: 'note', subscriberId: before.id, expectedVersion: 0,
      description: '=HYPERLINK("https://example.test","pay")\nВторая строка',
    });
    const second = await save({ kind: 'note', subscriberId: before.id, expectedVersion: 1, description: '@SUM(1,2)' });
    const excluded = await save(payment(before.id, 2));
    const response = await server.inject({
      method: 'GET', headers: operatorHeaders,
      url: `/api/transactions/export.csv?subscriberId=${before.id}&kind=note&order=asc&page=1&limit=1`,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.body).toContain(first.id);
    expect(response.body).toContain(second.id);
    expect(response.body).not.toContain(excluded.id);
    expect(response.body).toContain('"\'=HYPERLINK(""https://example.test"",""pay"")\nВторая строка"');
    expect(response.body).toContain('"\'@SUM(1,2)"');
  });

  it('схемы не позволяют подменять финансовые итоги, чужой снимок или тип внутренней операции', async () => {
    const before = await createSubscriber();
    const record = await save(payment(before.id));
    const requests = [
      { method: 'POST' as const, url: '/api/transactions', payload: { ...payment(before.id, 1), balanceKopeks: 999_999 } },
      { method: 'POST' as const, url: '/api/transactions', payload: { ...payment(before.id, 1), actor: { role: 'manager', id: 'forged' } } },
      { method: 'POST' as const, url: '/api/transactions', payload: { ...payment(before.id, 1), kind: 'maintenance-fee' } },
      { method: 'POST' as const, url: '/api/transactions', payload: { ...payment(before.id, 1), amount: 40 } },
      { method: 'PATCH' as const, url: `/api/transactions/${record.id}/description`, payload: { expectedVersion: 1, description: 'Подмена', reason: 'Подмена', balanceKopeks: 999_999 } },
      { method: 'POST' as const, url: `/api/transactions/${record.id}/cancel`, payload: { expectedVersion: 1, reason: 'Подмена', subscriberId: 'foreign' } },
    ];
    for (const request of requests) {
      const response = await server.inject({ ...request, headers: { ...operatorHeaders, 'idempotency-key': randomUUID() } });
      expect(response.statusCode, response.body).toBe(400);
    }
    const genericEdit = await server.inject({
      method: 'PATCH', url: `/api/transactions/${record.id}`, headers: operatorHeaders, payload: { balanceKopeks: 999_999 },
    });
    expect(genericEdit.statusCode).toBe(404);
    expect(await database.subscriber.findUnique({ where: { id: before.id } })).toMatchObject({ ...record.effect.after, version: 1 });
    expect((await view(record.id)).record).toEqual(record);
  });

  it('существующая передача показаний пишет доказательство в общий журнал без второго начисления', async () => {
    const before = await createSubscriber();
    const key = randomUUID();
    const request = {
      method: 'POST' as const, url: '/api/readings',
      headers: { ...operatorHeaders, 'idempotency-key': key },
      payload: { subscriberId: before.id, expectedVersion: 0, reading: '25.00' },
    };
    const response = await server.inject(request);
    expect(response.statusCode, response.body).toBe(201);
    const reading = response.json<SubmitReadingResult>().record;
    expect(await database.subscriber.findUnique({ where: { id: before.id } })).toMatchObject({
      readingHundredths: 2_500, balanceKopeks: -16_000, maintenanceBalanceKopeks: -1_500, version: 1,
    });
    const page = await application.transactions.list({ subscriberId: before.id }, operator);
    expect(page.total).toBe(1);
    expect(page.items[0]?.record).toMatchObject({
      id: reading.id, subscriberId: before.id, request: { action: 'reading-demo', reading },
      effect: { change: { balanceKopeks: -6_000, readingHundredths: 500, maintenanceBalanceKopeks: 0 } },
    });
    const replay = await server.inject(request);
    expect(replay.statusCode, replay.body).toBe(200);
    expect(await database.ledgerTransaction.count({ where: { subscriberId: before.id } })).toBe(1);
    expect(await database.reading.count({ where: { subscriberId: before.id } })).toBe(1);
    const cancellation = await cancel(reading.id, 1);
    expect(cancellation.statusCode, cancellation.body).toBe(201);
    expect(await database.subscriber.findUnique({ where: { id: before.id } })).toMatchObject({
      readingHundredths: before.readingHundredths, balanceKopeks: before.balanceKopeks, version: 2,
    });
    const history = await server.inject({ method: 'GET', url: `/api/subscribers/${before.id}/readings`, headers: operatorHeaders });
    expect(history.json().readings).toEqual([reading]);
  });
});
