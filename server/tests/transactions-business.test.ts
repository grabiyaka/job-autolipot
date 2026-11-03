import { describe, expect, it } from 'vitest';
import type { Actor, RecordedActor } from '../framework/core/actor.js';
import type { SubscriberSnapshot } from '../src/subscribers/SubscriberTypes.js';
import { readStoredTransaction } from '../src/transactions/TransactionSnapshotMapper.js';
import { prepareReadingTransaction, replayTransaction } from '../src/transactions/TransactionOperation.js';
import { TransactionQuery } from '../src/transactions/TransactionQuery.js';
import { calculateWaterCharge } from '../src/readings/ReadingRules.js';
import type { ReadingRecord } from '../src/readings/ReadingTypes.js';
import { calculateCancellation, calculateDescriptionChange, calculateTransaction } from '../src/transactions/TransactionRules.js';
import type { CreateTransactionInput, PaymentInput, TransactionEffect, TransactionKind, TransactionRecord } from '../src/transactions/TransactionTypes.js';

const operator: Actor = { id: 'operator', role: 'manager' };
const owner: Actor = { id: 'owner', role: 'guest', subscriberId: 'subscriber' };

function subscriber(overrides: Partial<SubscriberSnapshot> = {}): SubscriberSnapshot {
  return {
    id: 'subscriber', accountNumber: 'DEMO-TRANSACTION', displayName: 'Демо абонент', villageName: 'Демо село', meterNumber: 'DEMO-METER',
    readingHundredths: 10_000, balanceKopeks: -10_000, maintenanceBalanceKopeks: -1_500,
    waterTariffKopeks: 1_000, drainageTariffKopeks: 200, hasWater: true, hasDrainage: true,
    verifiedReadingHundredths: null, verifiedAt: null, verifiedByTransactionId: null, version: 0,
    ...overrides,
  };
}

function payment(overrides: Partial<PaymentInput> = {}): PaymentInput {
  return { kind: 'payment', subscriberId: 'subscriber', expectedVersion: 0, amount: '40', method: 'cash', ...overrides };
}

function reading(value: string, verified = false): CreateTransactionInput {
  return { kind: 'reading', subscriberId: 'subscriber', expectedVersion: 0, reading: value, verified };
}

function recorded(effect: TransactionEffect, overrides: Partial<TransactionRecord> = {}): TransactionRecord {
  return {
    id: 'transaction-1', sequence: 1, idempotencyKey: 'transaction-1-key',
    subscriberId: 'subscriber', accountNumber: 'DEMO-TRANSACTION', actor: operator,
    createdAt: '2026-10-08T12:00:00.000Z', effectiveAt: '2026-10-08T12:00:00.000Z',
    request: { action: 'create', input: payment() }, subscriberBefore: subscriber(), effect,
    verificationBefore: null, verificationAfter: null, reversesId: null, amendsId: null,
    ...overrides,
  };
}

describe('Распределение оплаты как в legacy Водогоне', () => {
  it('сначала погашает обслуживание, остаток направляет на воду', () => {
    const result = calculateTransaction(subscriber(), payment(), operator);
    expect(result.payment).toEqual({ amountKopeks: 4_000, waterKopeks: 2_500, maintenanceKopeks: 1_500, method: 'cash', externalReference: null, purpose: null });
    expect(result.after).toEqual({ balanceKopeks: -7_500, maintenanceBalanceKopeks: 0, readingHundredths: 10_000 });
    expect(result.policyVersion).toContain('maintenance-first');
  });

  it.each([
    [-5_000, '10', 1_000, 0, -4_000],
    [0, '200', 0, 20_000, 0],
    [3_000, '200', 0, 20_000, 3_000],
  ])('не создаёт аванс обслуживания: баланс %i, платёж %s', (maintenanceBalanceKopeks, amount, maintenance, water, after) => {
    const result = calculateTransaction(subscriber({ maintenanceBalanceKopeks }), payment({ amount }), operator);
    expect(result.payment?.maintenanceKopeks).toBe(maintenance);
    expect(result.payment?.waterKopeks).toBe(water);
    expect(result.after.maintenanceBalanceKopeks).toBe(after);
    expect(result.payment!.waterKopeks + result.payment!.maintenanceKopeks).toBe(result.payment!.amountKopeks);
  });

  it('сохраняет банковское происхождение и назначение без их переосмысления', () => {
    const result = calculateTransaction(subscriber(), payment({ method: 'bank', amount: '10,01', externalReference: ' BANK-DEMO-7 ', purpose: ' За воду ' }), operator);
    expect(result.category).toBe('bank');
    expect(result.payment).toMatchObject({ amountKopeks: 1_001, externalReference: 'BANK-DEMO-7', purpose: 'За воду' });
    expect(() => calculateTransaction(subscriber(), payment({ method: 'bank' }), operator)).toThrow(expect.objectContaining({ code: 'BANK_REFERENCE_REQUIRED' }));
  });

  it.each(['0', '-1', '10.005', '0.001', 'NaN', 'Infinity', '1e2', '', '.5'])('не принимает некорректную сумму %s', amount => {
    expect(() => calculateTransaction(subscriber(), payment({ amount }), operator)).toThrow(expect.objectContaining({ code: 'INVALID_PAYMENT' }));
  });

  it('принимает точные копейки с незначащими нулями и не округляет платёж', () => {
    expect(calculateTransaction(subscriber(), payment({ amount: '10.0100' }), operator).payment?.amountKopeks).toBe(1_001);
  });

  it('отклоняет переполнение суммы и нового баланса', () => {
    expect(() => calculateTransaction(subscriber(), payment({ amount: '21474836.48' }), operator)).toThrow(expect.objectContaining({ code: 'MONEY_OUT_OF_RANGE' }));
    expect(() => calculateTransaction(subscriber({ balanceKopeks: 2_147_483_647, maintenanceBalanceKopeks: 0 }), payment({ amount: '0.01' }), operator))
      .toThrow(expect.objectContaining({ code: 'MONEY_OUT_OF_RANGE' }));
  });
});

describe('Показания, звірка и перерасчёт', () => {
  it('положительное показание начисляет, отрицательная дельта оператора возвращает деньги', () => {
    const increase = calculateTransaction(subscriber(), reading('102'), operator);
    expect(increase.change).toEqual({ balanceKopeks: -2_400, maintenanceBalanceKopeks: 0, readingHundredths: 200 });
    const decrease = calculateTransaction(subscriber(), reading('99.66'), operator);
    expect(decrease.change).toEqual({ balanceKopeks: 408, maintenanceBalanceKopeks: 0, readingHundredths: -34 });
    expect(decrease.category).toBe('recalculation');
    expect(decrease.after.readingHundredths).toBe(9_966);
  });

  it('нормализует только один раз HALF_UP и округляет суммарный тариф', () => {
    const result = calculateTransaction(subscriber({ waterTariffKopeks: 149, drainageTariffKopeks: 149 }), reading('100,005'), operator);
    expect(result.after.readingHundredths).toBe(10_001);
    expect(result.change.balanceKopeks).toBe(-3);
    const correction = calculateTransaction(subscriber({ waterTariffKopeks: 150, hasDrainage: false }), reading('99.99'), operator);
    expect(correction.change.balanceKopeks).toBe(2);
  });

  it.each([[false, false, 0], [true, false, -1_000], [false, true, -200], [true, true, -1_200]])('учитывает услуги %s/%s', (hasWater, hasDrainage, charge) => {
    expect(calculateTransaction(subscriber({ hasWater, hasDrainage }), reading('101'), operator).change.balanceKopeks).toBe(charge);
  });

  it.each(['100', '100.004'])('отклоняет повторное показание %s', value => {
    expect(() => calculateTransaction(subscriber(), reading(value), operator)).toThrow(expect.objectContaining({ code: 'READING_UNCHANGED' }));
  });

  it.each(['0', '0.004', '-1', 'NaN', '1e2'])('отклоняет нулевое или неверное показание %s', value => {
    expect(() => calculateTransaction(subscriber(), reading(value), operator)).toThrow(expect.objectContaining({ code: 'INVALID_READING' }));
  });

  it('проверяет границу после округления', () => {
    expect(() => calculateTransaction(subscriber(), reading('9999999.995'), operator)).toThrow(expect.objectContaining({ code: 'READING_OUT_OF_RANGE' }));
  });

  it('абонент может передавать только своё возрастающее неподтверждённое показание', () => {
    expect(calculateTransaction(subscriber(), reading('101'), owner).confirmsReading).toBe(false);
    expect(() => calculateTransaction(subscriber(), reading('99'), owner)).toThrow(expect.objectContaining({ code: 'READING_MUST_INCREASE' }));
    expect(() => calculateTransaction(subscriber(), reading('101', true), owner)).toThrow(expect.objectContaining({ code: 'ACCESS_DENIED' }));
    expect(() => calculateTransaction(subscriber(), reading('101'), { ...owner, subscriberId: 'other' })).toThrow(expect.objectContaining({ code: 'ACCESS_DENIED' }));
    expect(() => calculateTransaction(subscriber(), payment(), owner)).toThrow(expect.objectContaining({ code: 'ACCESS_DENIED' }));
  });

  it('только явно подтверждённое оператором показание устанавливает звірку', () => {
    expect(calculateTransaction(subscriber(), reading('101'), operator).kind).toBe('meter-reading');
    expect(calculateTransaction(subscriber(), reading('101', true), operator)).toMatchObject({ kind: 'meter-reconciliation', confirmsReading: true });
  });

  it('быстрый перерасчёт устанавливает абсолютные значения и сохраняет точные дельты', () => {
    const result = calculateTransaction(subscriber(), {
      kind: 'reconciliation', subscriberId: 'subscriber', expectedVersion: 0,
      reading: '99.665', balance: '-80.005', maintenanceBalance: '0', reason: ' Уточнение состояния ',
    }, operator);
    expect(result.after).toEqual({ balanceKopeks: -8_001, maintenanceBalanceKopeks: 0, readingHundredths: 9_967 });
    expect(result.change).toEqual({ balanceKopeks: 1_999, maintenanceBalanceKopeks: 1_500, readingHundredths: -33 });
    expect(result.description).toBe('Уточнение состояния');
    expect(result.confirmsReading).toBe(true);
  });

  it('исправление только баланса не подтверждает показание; причина обязательна', () => {
    const input = { kind: 'reconciliation' as const, subscriberId: 'subscriber', expectedVersion: 0, reading: '100', balance: '-50', maintenanceBalance: '-15', reason: 'Исправление баланса' };
    expect(calculateTransaction(subscriber(), input, operator)).toMatchObject({ kind: 'recalculation', confirmsReading: false });
    expect(() => calculateTransaction(subscriber(), { ...input, reason: ' ' }, operator)).toThrow(expect.objectContaining({ code: 'REASON_REQUIRED' }));
  });
});

describe('Неизменяемая история и отмена с сохранением последующих операций', () => {
  it('отменяет исходное распределение платежа на текущем состоянии, сохраняя последующее начисление', () => {
    const source = recorded(calculateTransaction(subscriber(), payment(), operator));
    const laterSubscriber = subscriber({ ...source.effect.after });
    const later = recorded(calculateTransaction(laterSubscriber, reading('105'), operator), { id: 'transaction-2', sequence: 2 });
    const current = subscriber({ ...later.effect.after, waterTariffKopeks: 5_000 });
    const result = calculateCancellation(current, source, [source, later], 'Ошибочная оплата');
    expect(result.change).toEqual({ balanceKopeks: -2_500, maintenanceBalanceKopeks: -1_500, readingHundredths: 0 });
    expect(result.after).toEqual({ balanceKopeks: -16_000, maintenanceBalanceKopeks: -1_500, readingHundredths: 10_500 });
    expect(source.effect.payment).toMatchObject({ amountKopeks: 4_000, waterKopeks: 2_500, maintenanceKopeks: 1_500 });
    expect(later.effect.change.balanceKopeks).toBe(-6_000);
  });

  it('отменяет дробную коррекцию, сохраняя дельту последующего показания', () => {
    const source = recorded(calculateTransaction(subscriber(), reading('99.66'), operator));
    const later = recorded(calculateTransaction(subscriber({ ...source.effect.after }), reading('104'), operator), { id: 'transaction-2', sequence: 2 });
    const result = calculateCancellation(subscriber({ ...later.effect.after }), source, [source, later], 'Отмена коррекции');
    expect(result.change).toEqual({ balanceKopeks: -408, maintenanceBalanceKopeks: 0, readingHundredths: 34 });
    expect(result.after.readingHundredths).toBe(10_434);
    expect(later.effect.change.readingHundredths).toBe(434);
  });

  it('не допускает повторной отмены и отмены, создающей отрицательное показание', () => {
    const source = recorded(calculateTransaction(subscriber(), reading('105'), operator));
    const cancellation = recorded(source.effect, { id: 'cancel', sequence: 2, reversesId: source.id });
    expect(() => calculateCancellation(subscriber(), source, [source, cancellation], 'Повтор')).toThrow(expect.objectContaining({ code: 'TRANSACTION_ALREADY_CANCELLED' }));
    expect(() => calculateCancellation(subscriber({ readingHundredths: 0 }), source, [source], 'Отмена')).toThrow(expect.objectContaining({ code: 'READING_OUT_OF_RANGE' }));
  });

  it.each<TransactionKind>(['origin', 'maintenance-fee', 'maintenance-transfer', 'maintenance-fee-reversal', 'maintenance-transfer-reversal', 'meter-replacement-closing', 'meter-replacement-reset', 'cancellation', 'description-change'])('защищает специальные операции %s', kind => {
    const source = recorded({ ...calculateTransaction(subscriber(), payment(), operator), kind });
    expect(() => calculateCancellation(subscriber(), source, [source], 'Отмена')).toThrow(expect.objectContaining({ code: 'TRANSACTION_REQUIRES_DEDICATED_WORKFLOW' }));
    expect(() => calculateDescriptionChange(subscriber(), source, 'Изменено')).toThrow(expect.objectContaining({ code: 'TRANSACTION_REQUIRES_DEDICATED_WORKFLOW' }));
  });

  it('блокирует отмену перед действующим начислением обслуживания, учитывая sequence при одинаковом времени', () => {
    const source = recorded(calculateTransaction(subscriber(), payment(), operator));
    const fee = recorded({ ...source.effect, kind: 'maintenance-fee' }, { id: 'fee', sequence: 2 });
    expect(() => calculateCancellation(subscriber(), source, [source, fee], 'Отмена')).toThrow(expect.objectContaining({ code: 'TRANSACTION_HAS_LATER_MAINTENANCE' }));
    const reversal = recorded({ ...source.effect, kind: 'maintenance-fee-reversal' }, { id: 'fee-reversal', sequence: 3, reversesId: fee.id });
    expect(calculateCancellation(subscriber(), source, [source, fee, reversal], 'Отмена').kind).toBe('cancellation');
  });

  it('сначала учитывает business date, даже если строки записаны в другом порядке', () => {
    const source = recorded(calculateTransaction(subscriber(), payment(), operator), { sequence: 5 });
    const laterFee = recorded({ ...source.effect, kind: 'maintenance-fee' }, {
      id: 'fee-after', sequence: 2, effectiveAt: '2026-10-09T00:00:00.000Z',
    });
    expect(() => calculateCancellation(subscriber(), source, [source, laterFee], 'Отмена'))
      .toThrow(expect.objectContaining({ code: 'TRANSACTION_HAS_LATER_MAINTENANCE' }));
    const earlierFee = { ...laterFee, id: 'fee-before', sequence: 8, effectiveAt: '2026-10-07T00:00:00.000Z' };
    expect(calculateCancellation(subscriber(), source, [source, earlierFee], 'Отмена').kind).toBe('cancellation');
  });

  it('заметка и изменение описания не меняют состояние или подтверждение', () => {
    const state = subscriber();
    const note = calculateTransaction(state, { kind: 'note', subscriberId: state.id, expectedVersion: 0, description: 'Контакт уточнён' }, operator);
    expect(note.after).toEqual(note.before);
    expect(note.confirmsReading).toBe(false);
    const source = recorded(calculateTransaction(state, reading('101', true), operator));
    const changed = calculateDescriptionChange(state, source, ' Новое описание ');
    expect(changed.after).toEqual(changed.before);
    expect(changed.description).toBe('Новое описание');
    expect(changed.confirmsReading).toBe(false);
    expect(source.effect.confirmsReading).toBe(true);
  });

  it('результат отделён от входных данных и защищён от изменений', () => {
    const state = subscriber();
    const before = structuredClone(state);
    const result = calculateTransaction(Object.freeze(state), Object.freeze(payment()), operator);
    expect(state).toEqual(before);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.before)).toBe(true);
    expect(Object.isFrozen(result.after)).toBe(true);
    expect(Object.isFrozen(result.change)).toBe(true);
    expect(Object.isFrozen(result.payment)).toBe(true);
  });
});

function readPersisted(record: TransactionRecord): TransactionRecord {
  return readStoredTransaction({
    id: record.id, sequence: record.sequence, idempotencyKey: record.idempotencyKey,
    subscriberId: record.subscriberId, createdAt: new Date(record.createdAt), effectiveAt: new Date(record.effectiveAt),
    reversesId: record.reversesId, amendsId: record.amendsId,
    bankReference: record.effect.payment?.method === 'bank' ? record.effect.payment.externalReference : null,
    snapshot: record,
  });
}

describe('Роли в операциях и неизменяемых доказательствах', () => {
  it.each(['admin', 'manager'] as const)('роль %s выполняет финансовые операции и читает общий журнал', role => {
    const actor: Actor = { id: role, role };
    const result = calculateTransaction(subscriber(), payment(), actor);
    const record = recorded(result, { actor });
    expect(readPersisted(record)).toEqual(record);
    expect(new TransactionQuery({}, actor).subscriberId).toBeUndefined();
  });

  it('foreign не получает доступ к операциям или журналу через подставленную связь с абонентом', () => {
    const actor: Actor = { id: 'foreign', role: 'foreign', subscriberId: 'subscriber' };
    expect(() => calculateTransaction(subscriber(), payment(), actor)).toThrow(expect.objectContaining({ statusCode: 403 }));
    expect(() => calculateTransaction(subscriber(), reading('101'), actor)).toThrow(expect.objectContaining({ statusCode: 403 }));
    expect(() => new TransactionQuery({}, actor)).toThrow(expect.objectContaining({ statusCode: 403 }));
    expect(() => new TransactionQuery({ subscriberId: 'subscriber' }, actor)).toThrow(expect.objectContaining({ statusCode: 403 }));
  });

  it.each([
    { current: operator, legacyRole: 'operator', input: payment() },
    { current: owner, legacyRole: 'subscriber', input: reading('101') },
  ] as const)('декодирует и повторяет запись с исторической ролью $legacyRole без изменения снимка', ({ current, legacyRole, input }) => {
    const actor: RecordedActor = { ...current, role: legacyRole };
    const record = recorded(calculateTransaction(subscriber(), input, current), {
      actor, request: { action: 'create', input },
    });
    const originalJson = JSON.stringify(record);
    const restored = readPersisted(record);
    expect(restored).toEqual(record);
    expect(replayTransaction(restored, record.request, current)).toEqual({ record, replayed: true });
    expect(() => replayTransaction(restored, record.request, { ...current, id: 'other-user' }))
      .toThrow(expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }));
    expect(JSON.stringify(record)).toBe(originalJson);
  });

  it.each(['operator', 'subscriber'] as const)('backfill показаний сохраняет историческую роль %s во всех вложенных доказательствах', role => {
    const input = { subscriberId: 'subscriber', expectedVersion: 0, reading: '101' };
    const before = subscriber();
    const actor: RecordedActor = { id: 'legacy-user', role, subscriberId: before.id };
    const readingRecord: ReadingRecord = {
      id: 'legacy-reading', idempotencyKey: 'legacy-reading-key', originalInput: input, actor,
      source: 'demo-api', createdAt: '2026-10-08T10:00:00.000Z',
      subscriberBefore: before, calculation: calculateWaterCharge(before, input.reading),
    };
    const originalJson = JSON.stringify(readingRecord);
    const draft = prepareReadingTransaction(readingRecord);
    const record = readPersisted({ ...draft, sequence: 10 });
    expect(record.actor).toEqual(actor);
    expect(record.request).toEqual({ action: 'reading-demo', reading: readingRecord });
    expect(JSON.stringify(readingRecord)).toBe(originalJson);
  });
});
