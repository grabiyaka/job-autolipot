import { hasGeneralAccess } from '../../framework/core/roles.js';
import { ensureSubscriberAccess, normalizeRecordedActor, type Actor, type RecordedActor } from '../../framework/core/actor.js';
import { ApplicationError } from '../../framework/core/errors.js';
import type { ReadingRecord } from '../readings/ReadingTypes.js';
import type { ApplyLedgerState, SubscriberSnapshot } from '../subscribers/SubscriberTypes.js';
import type {
  CreateTransactionInput, TransactionDraft, TransactionEffect, TransactionRecord,
  TransactionRequest, TransactionResult, TransactionVerification,
} from './TransactionTypes.js';

export function requireTransactionGeneralAccess(actor: Actor): void {
  if (!hasGeneralAccess(actor)) {
    throw new ApplicationError('ACCESS_DENIED', 'Эту операцию может выполнить администратор или менеджер.', 403);
  }
}

export function ensureTransactionCreationAccess(input: CreateTransactionInput, actor: Actor): void {
  ensureSubscriberAccess(actor, input.subscriberId);
  if (!hasGeneralAccess(actor) && (input.kind !== 'reading' || input.verified)) {
    requireTransactionGeneralAccess(actor);
  }
}

export function ensureValidTransactionSubmission(expectedVersion: number, idempotencyKey: string): void {
  if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim() || idempotencyKey.length > 128) {
    throw new ApplicationError('INVALID_IDEMPOTENCY_KEY', 'Ключ операции должен содержать от 1 до 128 символов.', 400);
  }
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0 || expectedVersion > 2_147_483_647) {
    throw new ApplicationError('INVALID_VERSION', 'Передайте текущую версию абонента.', 400);
  }
}

export function ensureTransactionVersion(subscriber: SubscriberSnapshot, expectedVersion: number): void {
  if (subscriber.version !== expectedVersion) {
    throw new ApplicationError('STATE_CHANGED', 'Данные абонента изменились. Обновите расчёт операции.', 409);
  }
}

function canonical(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const fields = Object.entries(value).filter(([, entry]) => entry !== undefined);
  fields.sort(([left], [right]) => left.localeCompare(right));
  return `{${fields.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
}

export function replayTransaction(
  record: TransactionRecord, request: TransactionRequest, actor: RecordedActor,
): TransactionResult {
  if (canonical(record.request) !== canonical(request) || canonical(normalizeRecordedActor(record.actor)) !== canonical(normalizeRecordedActor(actor))) {
    throw new ApplicationError('IDEMPOTENCY_CONFLICT', 'Этот ключ операции уже использован для другого запроса.', 409);
  }
  return { record, replayed: true };
}

export function currentTransactionVerification(subscriber: SubscriberSnapshot): TransactionVerification | null {
  if (subscriber.verifiedByTransactionId === null || subscriber.verifiedReadingHundredths === null || subscriber.verifiedAt === null) {
    return null;
  }
  return {
    transactionId: subscriber.verifiedByTransactionId,
    readingHundredths: subscriber.verifiedReadingHundredths,
    confirmedAt: subscriber.verifiedAt,
  };
}

export function prepareTransaction(
  subscriber: SubscriberSnapshot,
  request: TransactionRequest,
  effect: TransactionEffect,
  actor: RecordedActor,
  idempotencyKey: string,
  id: string,
  createdAt: string,
  restoredVerification?: TransactionVerification | null,
): TransactionDraft {
  const verificationBefore = currentTransactionVerification(subscriber);
  const verificationAfter = restoredVerification !== undefined
    ? restoredVerification
    : effect.confirmsReading
      ? { transactionId: id, readingHundredths: effect.after.readingHundredths, confirmedAt: createdAt }
      : verificationBefore;

  return {
    id, idempotencyKey, subscriberId: subscriber.id, accountNumber: subscriber.accountNumber,
    actor: structuredClone(actor), createdAt, effectiveAt: createdAt,
    request: structuredClone(request), subscriberBefore: structuredClone(subscriber),
    effect: structuredClone(effect), verificationBefore, verificationAfter,
    reversesId: request.action === 'cancel' ? request.transactionId : null,
    amendsId: request.action === 'amend' ? request.transactionId : null,
  };
}

export function ledgerStateAfter(draft: TransactionDraft): ApplyLedgerState {
  return {
    subscriberId: draft.subscriberId,
    expectedVersion: draft.subscriberBefore.version,
    ...draft.effect.after,
    verifiedByTransactionId: draft.verificationAfter?.transactionId ?? null,
    verifiedReadingHundredths: draft.verificationAfter?.readingHundredths ?? null,
    verifiedAt: draft.verificationAfter?.confirmedAt ?? null,
  };
}

/** Bridge the original reading's immutable calculation; never calculate it against newer tariffs. */
export function prepareReadingTransaction(record: ReadingRecord): TransactionDraft {
  const calculation = record.calculation;
  const maintenanceBalanceKopeks = record.subscriberBefore.maintenanceBalanceKopeks;
  const effect: TransactionEffect = {
    kind: 'meter-reading', category: 'system', description: 'Нарахування за показанням лічильника',
    before: {
      balanceKopeks: calculation.balanceBeforeKopeks, maintenanceBalanceKopeks,
      readingHundredths: calculation.previousReadingHundredths,
    },
    change: {
      balanceKopeks: -calculation.chargeKopeks, maintenanceBalanceKopeks: 0,
      readingHundredths: calculation.consumptionHundredths,
    },
    after: {
      balanceKopeks: calculation.balanceAfterKopeks, maintenanceBalanceKopeks,
      readingHundredths: calculation.newReadingHundredths,
    },
    tariff: {
      waterKopeks: calculation.waterTariffKopeks, drainageKopeks: calculation.drainageTariffKopeks,
      effectiveKopeks: calculation.effectiveTariffKopeks,
      hasWater: calculation.hasWater, hasDrainage: calculation.hasDrainage,
    },
    payment: null, confirmsReading: false, policyVersion: calculation.policyVersion,
  };
  return prepareTransaction(
    record.subscriberBefore, { action: 'reading-demo', reading: record }, effect,
    record.actor, `reading-demo:${record.idempotencyKey}`, record.id, record.createdAt,
  );
}
