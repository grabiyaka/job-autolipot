import { describe, expect, it } from 'vitest';
import { presentTransactions, verificationAfterCancellation } from '../src/transactions/TransactionHistory.js';
import type {
  TransactionEffect, TransactionRecord, TransactionState, TransactionVerification,
} from '../src/transactions/TransactionTypes.js';

function state(balanceKopeks = 0, maintenanceBalanceKopeks = 0, readingHundredths = 2_000): TransactionState {
  return { balanceKopeks, maintenanceBalanceKopeks, readingHundredths };
}

function entry(
  id: string, sequence: number, effect: Partial<TransactionEffect> = {}, record: Partial<TransactionRecord> = {},
): TransactionRecord {
  const createdAt = `2026-01-${String(sequence).padStart(2, '0')}T12:00:00.000Z`;
  return {
    id, sequence, idempotencyKey: id, subscriberId: 'subscriber-1', accountNumber: 'DEMO-1',
    actor: { id: 'operator-1', role: 'operator' }, createdAt, effectiveAt: createdAt,
    request: { action: 'create', input: { kind: 'note', subscriberId: 'subscriber-1', expectedVersion: 0, description: id } },
    subscriberBefore: {
      id: 'subscriber-1', accountNumber: 'DEMO-1', displayName: 'Демо абонент', villageName: 'Демо село',
      meterNumber: 'DEMO-1', readingHundredths: 2_000, balanceKopeks: 0, maintenanceBalanceKopeks: 0,
      verifiedReadingHundredths: null, verifiedAt: null, verifiedByTransactionId: null,
      waterTariffKopeks: 1_000, drainageTariffKopeks: 200, hasWater: true, hasDrainage: true, version: 0,
    },
    effect: {
      kind: 'note', category: 'note', description: id,
      before: state(), change: state(0, 0, 0), after: state(),
      tariff: { waterKopeks: 1_000, drainageKopeks: 200, effectiveKopeks: 1_200, hasWater: true, hasDrainage: true },
      payment: null, confirmsReading: false, policyVersion: 'test/v1', ...effect,
    },
    verificationBefore: null, verificationAfter: null, reversesId: null, amendsId: null, ...record,
  };
}

function cancelled(source: TransactionRecord, sequence: number, id = `cancel-${source.id}`): TransactionRecord {
  return entry(id, sequence, {
    kind: 'cancellation',
    change: state(-source.effect.change.balanceKopeks, -source.effect.change.maintenanceBalanceKopeks,
      -source.effect.change.readingHundredths),
  }, { reversesId: source.id, subscriberId: source.subscriberId });
}

function verified(id: string, sequence: number, before: number, after: number): TransactionRecord {
  return entry(id, sequence, {
    kind: 'meter-reconciliation', confirmsReading: true,
    before: state(0, 0, before), change: state(0, 0, after - before), after: state(0, 0, after),
  });
}

describe('Представление неизменяемой истории транзакций', () => {
  it('сортирует по моменту операции и порядковому номеру, включая одинаковое время', () => {
    const first = entry('first', 1, {}, { effectiveAt: '2026-01-01T14:00:00+02:00' });
    const second = entry('second', 2, {}, { effectiveAt: '2026-01-01T12:00:00.000Z' });
    const earlier = entry('earlier', 3, {}, { effectiveAt: '2026-01-01T11:00:00.000Z' });
    const records = Object.freeze([second, first, earlier]);
    expect(presentTransactions(records).map(view => view.record.id)).toEqual(['earlier', 'first', 'second']);
    expect(records).toEqual([second, first, earlier]);
  });

  it('отменяет исходное распределение платежа и сохраняет последующее начисление и его исходный снимок', () => {
    const payment = entry('payment', 1, {
      kind: 'payment', before: state(-10_000, -1_500), change: state(2_500, 1_500, 0), after: state(-7_500),
    });
    const charge = entry('charge', 2, {
      kind: 'meter-reading', before: state(-7_500), change: state(-6_000, 0, 500), after: state(-13_500, 0, 2_500),
    });
    const cancellation = cancelled(payment, 3);
    const originalEvidence = structuredClone([payment, charge, cancellation]);
    const views = presentTransactions([payment, charge, cancellation]);

    expect(views[0]?.cancelledBy).toBe(cancellation.id);
    expect(views[1]?.projection).toEqual({ before: state(-10_000, -1_500), after: state(-16_000, -1_500, 2_500) });
    expect(views[1]?.record).toBe(charge);
    expect(views[1]?.record.effect.change).toEqual(state(-6_000, 0, 500));
    expect(views[2]?.record).toBe(cancellation);
    expect(views[2]?.projection).toEqual({ before: cancellation.effect.before, after: cancellation.effect.after });
    expect([payment, charge, cancellation]).toEqual(originalEvidence);
  });

  it('сохраняет точный дробный сдвиг показаний после отмены технического исправления', () => {
    const correction = entry('correction', 1, {
      kind: 'recalculation', before: state(0, 0, 99_600), change: state(0, 0, -34), after: state(0, 0, 99_566),
    });
    const reading = entry('reading', 2, {
      kind: 'meter-reading', before: state(0, 0, 99_566), change: state(0, 0, 434), after: state(0, 0, 100_000),
    });
    expect(presentTransactions([correction, reading, cancelled(correction, 3)])[1]).toMatchObject({
      projection: { before: state(0, 0, 99_600), after: state(0, 0, 100_034) },
      record: { effect: { change: state(0, 0, 434), after: state(0, 0, 100_000) } },
    });
  });

  it('не применяет отмену повторно к операциям, записанным после неё, или к её дубликату', () => {
    const payment = entry('payment', 1, { kind: 'payment', change: state(3_000, 0, 0) });
    const beforeCancellation = entry('before', 2, { before: state(3_000), after: state(3_000) });
    const afterCancellation = entry('after', 4, { before: state(0), after: state(0) });
    const views = presentTransactions([
      cancelled(payment, 5, 'duplicate'), afterCancellation, cancelled(payment, 3), beforeCancellation, payment,
    ]);
    expect(views[0]?.cancelledBy).toBe('cancel-payment');
    expect(views[1]?.projection).toEqual({ before: state(0), after: state(0) });
    expect(views[3]?.projection).toEqual({ before: state(0), after: state(0) });
  });

  it('складывает независимые отмены и учитывает порядок при одинаковом времени', () => {
    const first = entry('first', 1, { kind: 'payment', change: state(3_000, 0, 0) });
    const second = entry('second', 2, { kind: 'payment', change: state(1_000, 500, 0) });
    const third = entry('third', 3, { before: state(4_000, 500), after: state(4_000, 500) });
    const rows = [first, second, third, cancelled(first, 4), cancelled(second, 5)]
      .map(record => ({ ...record, effectiveAt: first.effectiveAt }));
    expect(presentTransactions(rows)[2]?.projection).toEqual({ before: state(), after: state() });
  });

  it('показывает последнее исправление описания отдельно от исходной записи и аудита изменений', () => {
    const payment = entry('payment', 1, { kind: 'payment', description: 'Первая подпись' });
    const first = entry('amend-1', 2, { kind: 'description-change', description: 'Вторая подпись' }, { amendsId: payment.id });
    const second = entry('amend-2', 3, { kind: 'description-change', description: 'Третья подпись' }, { amendsId: payment.id });
    const views = presentTransactions([second, first, payment]);
    expect(views.map(view => view.description)).toEqual(['Третья подпись', 'Вторая подпись', 'Третья подпись']);
    expect(views[0]?.record.effect.description).toBe('Первая подпись');
    expect(views[1]?.record.amendsId).toBe(payment.id);
  });

  it('не смешивает историю абонентов и игнорирует недействительные ссылки отмены', () => {
    const payment = entry('payment', 2, { kind: 'payment', change: state(3_000, 0, 0) });
    const other = entry('other', 3, {}, { subscriberId: 'subscriber-2' });
    const forgedCancellation = { ...cancelled(payment, 4), subscriberId: 'subscriber-2' };
    const forgedAmendment = entry('amend', 5, { kind: 'description-change', description: 'Forged' },
      { subscriberId: 'subscriber-2', amendsId: payment.id });
    const views = presentTransactions([payment, other, forgedCancellation, forgedAmendment, cancelled(payment, 1)]);
    expect(views.find(view => view.record.id === payment.id)).toMatchObject({ description: payment.effect.description, cancelledBy: null });
    expect(views.find(view => view.record.id === other.id)?.projection.after).toEqual(other.effect.after);
  });
});

describe('Восстановление подтверждённого показания при отмене', () => {
  it('возвращает предыдущую активную сверку и очищает единственную отменённую сверку', () => {
    const first = verified('first', 1, 2_000, 2_025);
    const latest = verified('latest', 2, 2_025, 2_125);
    expect(verificationAfterCancellation([latest, first], latest)).toEqual({
      transactionId: first.id, readingHundredths: 2_025, confirmedAt: first.effectiveAt,
    });
    expect(verificationAfterCancellation([first], first)).toBeNull();
  });

  it('сдвигает показание более поздней сверки после отмены предыдущего движения', () => {
    const first = verified('first', 1, 2_000, 2_025);
    const latest = verified('latest', 2, 2_025, 2_125);
    expect(verificationAfterCancellation([first, latest], first)).toEqual({
      transactionId: latest.id, readingHundredths: 2_100, confirmedAt: latest.effectiveAt,
    });
  });

  it('отклоняет отмену с отрицательной восстановленной сверкой, даже если текущий счётчик остаётся допустимым', () => {
    const source = entry('source', 1, {
      kind: 'meter-reading', before: state(0, 0, 0), change: state(0, 0, 100), after: state(0, 0, 100),
    });
    const confirmed = verified('confirmed', 2, 100, 50);
    const later = entry('later', 3, {
      kind: 'meter-reading', before: state(0, 0, 50), change: state(0, 0, 150), after: state(0, 0, 200),
    });
    const records = [source, confirmed, later];
    const originalEvidence = structuredClone(records);
    expect(later.effect.after.readingHundredths - source.effect.change.readingHundredths).toBe(100);
    expect(() => verificationAfterCancellation(records, source)).toThrow(expect.objectContaining({
      code: 'TRANSACTION_UNSAFE_CANCELLATION', statusCode: 409,
    }));
    expect(records).toEqual(originalEvidence);
  });

  it.each([-1, 1_000_000_000, Number.MAX_SAFE_INTEGER + 1, 0.5, Number.NaN])(
    'не сохраняет недопустимую унаследованную сверку %s при отмене', readingHundredths => {
      const payment = entry('payment', 1, { kind: 'payment' }, {
        verificationBefore: {
          transactionId: 'previous-reading', readingHundredths, confirmedAt: '2025-12-31T12:00:00.000Z',
        },
      });
      expect(() => verificationAfterCancellation([payment], payment)).toThrow(expect.objectContaining({
        code: 'TRANSACTION_UNSAFE_CANCELLATION', statusCode: 409,
      }));
    },
  );

  it('учитывает уже отменённые записи, не возвращает их сверки и не вычитает отмену повторно', () => {
    const first = verified('first', 1, 2_000, 2_025);
    const latest = verified('latest', 2, 2_025, 2_125);
    const firstCancellation = cancelled(first, 3);
    expect(verificationAfterCancellation([first, latest, firstCancellation], first)?.readingHundredths).toBe(2_100);
    expect(verificationAfterCancellation([first, latest, firstCancellation], latest)).toBeNull();
  });

  it('не делает неподтверждённые, технические, начальные и нулевые операции сверкой', () => {
    const payment = entry('payment', 1, { kind: 'payment' });
    const unverified = entry('unverified', 2, { kind: 'meter-reading', confirmsReading: false });
    const imported = entry('imported', 3, { kind: 'meter-reading', confirmsReading: false });
    const balanceOnly = entry('balance-only', 4, { kind: 'recalculation', change: state(1_000, 0, 0) });
    const origin = entry('origin', 5, { kind: 'origin', confirmsReading: false });
    const unconfirmedType = entry('unconfirmed-type', 6, { kind: 'meter-reconciliation', confirmsReading: false });
    expect(verificationAfterCancellation([payment, unverified, imported, balanceOnly, origin, unconfirmedType], payment)).toBeNull();
  });

  it('сохраняет прежнюю сверку до начала журнала, включая нулевое показание', () => {
    const previous: TransactionVerification = {
      transactionId: 'earlier-reading', readingHundredths: 0, confirmedAt: '2025-12-31T12:00:00.000Z',
    };
    const first = entry('first', 1, {}, { verificationBefore: previous });
    const latest = verified('latest', 2, 2_000, 2_100);
    expect(verificationAfterCancellation([first, latest], latest)).toEqual(previous);

    const snapshotOnly = {
      ...first, verificationBefore: null,
      subscriberBefore: {
        ...first.subscriberBefore, verifiedByTransactionId: previous.transactionId,
        verifiedReadingHundredths: 0, verifiedAt: previous.confirmedAt,
      },
    };
    expect(verificationAfterCancellation([snapshotOnly, latest], latest)).toEqual(previous);
  });

  it('не воскрешает отменённую или неподтверждённую запись через устаревший снимок абонента', () => {
    const note = entry('note', 1);
    const stale = entry('stale', 2, {}, {
      verificationBefore: { transactionId: note.id, readingHundredths: 2_000, confirmedAt: note.effectiveAt },
    });
    expect(verificationAfterCancellation([note, stale], stale)).toBeNull();

    const inherited = entry('inherited', 1, {}, {
      verificationBefore: { transactionId: 'missing-source', readingHundredths: 2_000, confirmedAt: note.effectiveAt },
    });
    const cancellation = entry('cancellation', 2, { kind: 'cancellation' }, { reversesId: 'missing-source' });
    expect(verificationAfterCancellation([inherited, cancellation, stale], stale)).toBeNull();
  });

  it('восстанавливает только сверку нужного абонента и её исходную дату подтверждения', () => {
    const verification = verified('verified', 1, 2_000, 2_100);
    const confirmedAt = '2026-01-01T11:00:00.000Z';
    const source = { ...verification, verificationAfter: { transactionId: verification.id, readingHundredths: 2_100, confirmedAt } };
    const payment = entry('payment', 2, { kind: 'payment' });
    const stranger = { ...verified('stranger', 3, 5_000, 5_100), subscriberId: 'subscriber-2' };
    expect(verificationAfterCancellation([source, payment, stranger], payment)).toEqual({
      transactionId: source.id, readingHundredths: 2_100, confirmedAt,
    });
  });
});
