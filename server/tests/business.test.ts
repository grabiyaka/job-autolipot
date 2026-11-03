import { describe, expect, it, vi } from 'vitest';
import type { Actor, RecordedActor } from '../framework/core/actor.js';
import { readStoredReading } from '../src/readings/ReadingSnapshotMapper.js';
import { ReadingService } from '../src/readings/ReadingService.js';
import { calculateWaterCharge } from '../src/readings/ReadingRules.js';
import type { ReadingUnitOfWork } from '../src/readings/ReadingContracts.js';
import type { ReadingRepositoryContract } from '../src/readings/ReadingContracts.js';
import type { ReadingRecord, SubmitReadingInput } from '../src/readings/ReadingTypes.js';
import { SubscriberService } from '../src/subscribers/SubscriberService.js';
import type { SubscriberRepositoryContract } from '../src/subscribers/SubscriberContracts.js';
import type { SubscriberSnapshot } from '../src/subscribers/SubscriberTypes.js';

const operator: Actor = { id: 'operator-1', role: 'manager' };
const owner: Actor = { id: 'owner-1', role: 'guest', subscriberId: 'subscriber-1' };
const stranger: Actor = { id: 'other-1', role: 'guest', subscriberId: 'subscriber-2' };
const input: SubmitReadingInput = { subscriberId: 'subscriber-1', reading: '102,005', expectedVersion: 0 };

function subscriber(overrides: Partial<SubscriberSnapshot> = {}): SubscriberSnapshot {
  return {
    id: 'subscriber-1', accountNumber: '000001', displayName: 'Демо абонент', villageName: 'Демо село',
    meterNumber: 'DEMO-001', readingHundredths: 10_000, balanceKopeks: 100_000,
    maintenanceBalanceKopeks: 0, verifiedReadingHundredths: null, verifiedAt: null, verifiedByTransactionId: null,
    waterTariffKopeks: 3_000, drainageTariffKopeks: 1_500, hasWater: true, hasDrainage: true,
    version: 0, ...overrides,
  };
}

/** In-memory transactional fake, so application tests exercise the public boundaries. */
function fixture() {
  let state = subscriber();
  let nextId = 0;
  const records = new Map<string, ReadingRecord>();
  const subscriberRepository: SubscriberRepositoryContract = {
    list: vi.fn(async () => [state]),
    findById: vi.fn(async id => id === state.id ? { ...state } : null),
    updateMeterState: vi.fn(async change => {
      if (change.subscriberId !== state.id || change.expectedVersion !== state.version) return false;
      state = {
        ...state, readingHundredths: change.readingHundredths,
        balanceKopeks: change.balanceKopeks, version: state.version + 1,
      };
      return true;
    }),
    updateLedgerState: vi.fn(async change => {
      if (change.subscriberId !== state.id || change.expectedVersion !== state.version) return false;
      const { subscriberId: _subscriberId, expectedVersion: _expectedVersion, ...values } = change;
      state = { ...state, ...values, version: state.version + 1 };
      return true;
    }),
  };
  const subscribers = new SubscriberService(subscriberRepository);
  const readings: ReadingRepositoryContract = {
    findByIdempotencyKey: vi.fn(async key => records.get(key) ?? null),
    save: vi.fn(async record => { records.set(record.idempotencyKey, record); }),
    historyFor: vi.fn(async id => [...records.values()].filter(record => record.originalInput.subscriberId === id)),
  };
  const unitOfWork: ReadingUnitOfWork = {
    async run(operation) {
      const before = { ...state };
      const recordsBefore = new Map(records);
      try {
        return await operation({ subscribers, readings, transactions: { recordReading: async () => {} } });
      } catch (error) {
        state = before;
        records.clear();
        for (const [key, record] of recordsBefore) records.set(key, record);
        throw error;
      }
    },
  };
  const service = new ReadingService(
    subscribers, readings, unitOfWork,
    { now: () => new Date('2026-01-15T12:30:00.000Z') },
    { next: () => `reading-${++nextId}` },
  );
  return { service, subscribers, subscriberRepository, readings, unitOfWork, records, state: () => state };
}

describe('Правила начисления за показание воды', () => {
  it('вычисляет расход и уменьшает баланс на сумму начисления', () => {
    const result = calculateWaterCharge(subscriber(), '102');
    expect(result).toEqual({
      subscriberId: 'subscriber-1', accountNumber: '000001',
      previousReadingHundredths: 10_000, newReadingHundredths: 10_200, consumptionHundredths: 200,
      waterTariffKopeks: 3_000, drainageTariffKopeks: 1_500, effectiveTariffKopeks: 4_500,
      hasWater: true, hasDrainage: true, chargeKopeks: 9_000,
      balanceBeforeKopeks: 100_000, balanceAfterKopeks: 91_000,
      subscriberVersion: 0, policyVersion: 'water-reading/v1',
    });
  });

  it('точно округляет десятичную строку HALF_UP и принимает запятую', () => {
    const result = calculateWaterCharge(subscriber({ readingHundredths: 0 }), '1,005');
    expect(result.newReadingHundredths).toBe(101);
    expect(result.chargeKopeks).toBe(4_545);
  });

  it('округляет перенос в целую часть без погрешности floating point', () => {
    expect(calculateWaterCharge(subscriber(), '100.995').newReadingHundredths).toBe(10_100);
  });

  it('сначала складывает тарифы, затем округляет начисление один раз', () => {
    const result = calculateWaterCharge(subscriber({ waterTariffKopeks: 149, drainageTariffKopeks: 149 }), '100.01');
    expect(result.chargeKopeks).toBe(3);
  });

  it('округляет половину копейки вверх', () => {
    expect(calculateWaterCharge(subscriber({ waterTariffKopeks: 150, hasDrainage: false }), '100.01').chargeKopeks).toBe(2);
  });

  it.each([
    [true, false, 3_000], [false, true, 1_500], [false, false, 0],
  ])('учитывает включённые услуги: вода=%s, стоки=%s', (hasWater, hasDrainage, expectedCharge) => {
    const result = calculateWaterCharge(subscriber({ hasWater, hasDrainage }), '101');
    expect(result.chargeKopeks).toBe(expectedCharge);
    expect(result.balanceAfterKopeks).toBe(100_000 - expectedCharge);
  });

  it.each(['99.99', '100', '100.004'])('отклоняет неувеличившееся показание %s после нормализации', reading => {
    expect(() => calculateWaterCharge(subscriber(), reading)).toThrow(expect.objectContaining({ code: 'READING_MUST_INCREASE' }));
  });

  it.each(['', 'abc', '-1', '1e3', 'Infinity', '1,2.3', '.5'])('отклоняет некорректное показание %s', reading => {
    expect(() => calculateWaterCharge(subscriber(), reading)).toThrow(expect.objectContaining({ code: 'INVALID_READING' }));
  });

  it('проверяет границу показания после округления', () => {
    const noCharge = subscriber({ hasWater: false, hasDrainage: false });
    expect(calculateWaterCharge(noCharge, '9999999.994').newReadingHundredths).toBe(999_999_999);
    expect(() => calculateWaterCharge(noCharge, '9999999.995')).toThrow(expect.objectContaining({ code: 'READING_OUT_OF_RANGE' }));
  });

  it('не допускает переполнение суммы или баланса при записи в БД', () => {
    expect(() => calculateWaterCharge(subscriber({ balanceKopeks: -2_147_483_648 }), '101'))
      .toThrow(expect.objectContaining({ code: 'MONEY_OUT_OF_RANGE' }));
    expect(() => calculateWaterCharge(subscriber({ waterTariffKopeks: 2_147_483_647, hasDrainage: false }), '102'))
      .toThrow(expect.objectContaining({ code: 'MONEY_OUT_OF_RANGE' }));
  });

  it('не изменяет переданный снимок абонента', () => {
    const before = Object.freeze(subscriber());
    calculateWaterCharge(before, '101');
    expect(before).toEqual(subscriber());
  });
});

describe('Сценарий передачи показаний', () => {
  it('предварительный расчёт ничего не сохраняет', async () => {
    const app = fixture();
    const result = await app.service.preview(input, owner);
    expect(result.newReadingHundredths).toBe(10_201);
    expect(app.state()).toEqual(subscriber());
    expect(app.readings.save).not.toHaveBeenCalled();
  });

  it('сохраняет нормализованное состояние и исходный запрос с полным снимком', async () => {
    const app = fixture();
    const result = await app.service.submit(input, owner, 'operation-1');
    expect(result.replayed).toBe(false);
    expect(result.record).toMatchObject({
      id: 'reading-1', originalInput: input, actor: owner, source: 'demo-api',
      createdAt: '2026-01-15T12:30:00.000Z', subscriberBefore: subscriber(),
      calculation: { newReadingHundredths: 10_201, chargeKopeks: 9_045 },
    });
    expect(app.state()).toMatchObject({ readingHundredths: 10_201, balanceKopeks: 90_955, version: 1 });
    expect(await app.service.history(input.subscriberId, owner)).toEqual([result.record]);
  });

  it('повтор операции возвращает исходную запись до проверки уже устаревшей версии', async () => {
    const app = fixture();
    const first = await app.service.submit(input, owner, 'same-operation');
    const replay = await app.service.submit(input, owner, 'same-operation');
    expect(replay).toEqual({ record: first.record, replayed: true });
    expect(app.subscriberRepository.updateMeterState).toHaveBeenCalledTimes(1);
    expect(app.readings.save).toHaveBeenCalledTimes(1);
  });

  it.each([
    { current: operator, legacyRole: 'operator' },
    { current: owner, legacyRole: 'subscriber' },
  ] as const)('читает и повторяет старый снимок $legacyRole после миграции роли без перезаписи', async ({ current, legacyRole }) => {
    const app = fixture();
    const first = await app.service.submit(input, current, 'legacy-operation');
    const legacyActor: RecordedActor = { ...current, role: legacyRole };
    const snapshot: ReadingRecord = { ...first.record, actor: legacyActor };
    const row = {
      id: snapshot.id, idempotencyKey: snapshot.idempotencyKey, subscriberId: input.subscriberId,
      createdAt: new Date(snapshot.createdAt), snapshot,
    };
    const originalJson = JSON.stringify(row.snapshot);
    const stored = readStoredReading(row);
    app.records.set(snapshot.idempotencyKey, stored);

    expect(stored.actor).toEqual(legacyActor);
    expect(await app.service.history(input.subscriberId, current)).toEqual([snapshot]);
    expect(await app.service.submit(input, current, snapshot.idempotencyKey))
      .toEqual({ record: snapshot, replayed: true });
    expect(JSON.stringify(row.snapshot)).toBe(originalJson);
    expect(app.readings.save).toHaveBeenCalledTimes(1);
  });

  it.each(['admin', 'manager'] as const)('роль %s может работать с показаниями любого абонента', async role => {
    const app = fixture();
    const actor: Actor = { id: role, role };
    const result = await app.service.submit(input, actor, `allowed-${role}`);
    expect(result.record.actor).toEqual(actor);
    expect(await app.service.history(input.subscriberId, actor)).toEqual([result.record]);
  });

  it('foreign не получает доступ через подставленный subscriberId при прямом вызове сервиса', async () => {
    const app = fixture();
    const actor: Actor = { id: 'foreign', role: 'foreign', subscriberId: input.subscriberId };
    await expect(app.service.preview(input, actor)).rejects.toMatchObject({ statusCode: 403 });
    await expect(app.service.submit(input, actor, 'forged-owner')).rejects.toMatchObject({ statusCode: 403 });
    await expect(app.service.history(input.subscriberId, actor)).rejects.toMatchObject({ statusCode: 403 });
    await expect(app.subscribers.listFor(actor)).rejects.toMatchObject({ statusCode: 403 });
    expect(app.subscriberRepository.findById).not.toHaveBeenCalled();
    expect(app.subscriberRepository.list).not.toHaveBeenCalled();
  });

  it('не объединяет разные исходные строки даже с одинаковым числовым результатом', async () => {
    const app = fixture();
    await app.service.submit(input, owner, 'same-operation');
    await expect(app.service.submit({ ...input, reading: '102.005' }, owner, 'same-operation'))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', statusCode: 409 });
  });

  it('не возвращает идемпотентную запись другому оператору', async () => {
    const app = fixture();
    await app.service.submit(input, owner, 'same-operation');
    await expect(app.service.submit(input, operator, 'same-operation'))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', statusCode: 409 });
  });

  it('заставляет пересчитать начисление при изменении версии', async () => {
    const app = fixture();
    await app.service.submit(input, operator, 'first');
    await expect(app.service.submit({ ...input, reading: '103' }, operator, 'second'))
      .rejects.toMatchObject({ code: 'STATE_CHANGED', statusCode: 409 });
    expect(app.records.size).toBe(1);
  });

  it('проверяет доступ в приложении для расчёта, сохранения и истории', async () => {
    const app = fixture();
    await expect(app.service.preview(input, stranger)).rejects.toMatchObject({ code: 'ACCESS_DENIED', statusCode: 403 });
    await expect(app.service.submit(input, stranger, 'blocked')).rejects.toMatchObject({ code: 'ACCESS_DENIED', statusCode: 403 });
    await expect(app.service.history(input.subscriberId, stranger)).rejects.toMatchObject({ code: 'ACCESS_DENIED', statusCode: 403 });
    expect(app.subscriberRepository.findById).not.toHaveBeenCalled();
    expect(app.readings.historyFor).not.toHaveBeenCalled();
  });

  it.each(['', ' ', 'a'.repeat(129)])('проверяет ключ идемпотентности', async key => {
    await expect(fixture().service.submit(input, operator, key)).rejects.toMatchObject({ code: 'INVALID_IDEMPOTENCY_KEY' });
  });

  it('откатывает изменение абонента, когда не удалось сохранить историю', async () => {
    const app = fixture();
    vi.spyOn(app.readings, 'save').mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(app.service.submit(input, operator, 'failed')).rejects.toThrow('storage unavailable');
    expect(app.state()).toEqual(subscriber());
    expect(app.records.size).toBe(0);
  });

  it('возвращает результат параллельной операции после отката своей транзакции', async () => {
    const app = fixture();
    const committed = await app.service.submit(input, owner, 'concurrent');
    app.records.clear();
    vi.spyOn(app.unitOfWork, 'run').mockImplementation(async () => {
      app.records.set('concurrent', committed.record);
      throw new Error('concurrent transaction won');
    });
    await expect(app.service.submit(input, owner, 'concurrent'))
      .resolves.toEqual({ record: committed.record, replayed: true });
  });
});

describe('Публичный сервис абонентов', () => {
  it('ограничивает список абонента его собственной записью', async () => {
    const app = fixture();
    expect(await app.subscribers.listFor(owner)).toEqual([subscriber()]);
    expect(await app.subscribers.listFor(stranger)).toEqual([]);
    expect(app.subscriberRepository.list).not.toHaveBeenCalled();
    expect(await app.subscribers.listFor(operator)).toEqual([subscriber()]);
  });

  it('возвращает 404 для отсутствующего абонента', async () => {
    await expect(fixture().subscribers.getById('missing')).rejects.toMatchObject({ code: 'SUBSCRIBER_NOT_FOUND', statusCode: 404 });
  });

  it('защищает обновление от устаревшей версии', async () => {
    await expect(fixture().subscribers.applyMeterReading({
      subscriberId: 'subscriber-1', expectedVersion: 1, readingHundredths: 20_000, balanceKopeks: 0,
    })).rejects.toMatchObject({ code: 'STATE_CHANGED', statusCode: 409 });
  });
});
