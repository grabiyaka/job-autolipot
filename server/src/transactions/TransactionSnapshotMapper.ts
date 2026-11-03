import { hasGeneralAccess } from '../../framework/core/roles.js';
import { normalizeRecordedActor, recordedActorRoles, type RecordedActor } from '../../framework/core/actor.js';
import type { LedgerTransaction } from '../../generated/prisma/client.js';
import type { ReadingCalculation, ReadingRecord } from '../readings/ReadingTypes.js';
import type { SubscriberSnapshot } from '../subscribers/SubscriberTypes.js';
import type {
  CreateTransactionInput, TransactionCategory, TransactionEffect, TransactionKind,
  TransactionPayment, TransactionRecord, TransactionRequest, TransactionState,
  TransactionTariff, TransactionVerification,
} from './TransactionTypes.js';

function invalid(): never { throw new Error('Stored transaction snapshot is invalid.'); }
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function object(value: unknown): Record<string, unknown> {
  return isObject(value) ? value : invalid();
}
function text(value: unknown): string { return typeof value === 'string' ? value : invalid(); }
function integer(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : invalid();
}
function nonnegative(value: unknown): number {
  const result = integer(value);
  return result >= 0 ? result : invalid();
}
function flag(value: unknown): boolean { return typeof value === 'boolean' ? value : invalid(); }
function nullableText(value: unknown): string | null { return value === null ? null : text(value); }
function nullableReading(value: unknown): number | null { return value === null ? null : nonnegative(value); }
function timestamp(value: unknown): string {
  const result = text(value);
  const date = new Date(result);
  return Number.isFinite(date.valueOf()) && date.toISOString() === result ? result : invalid();
}
function nullableTimestamp(value: unknown): string | null { return value === null ? null : timestamp(value); }
function oneOf<const T extends readonly string[]>(value: unknown, choices: T): T[number] {
  for (const choice of choices) if (value === choice) return choice;
  return invalid();
}

function actor(value: unknown): RecordedActor {
  const data = object(value);
  const role = oneOf(data.role, recordedActorRoles);
  return data.subscriberId === undefined
    ? { id: text(data.id), role }
    : { id: text(data.id), role, subscriberId: text(data.subscriberId) };
}

function subscriber(value: unknown): SubscriberSnapshot {
  const data = object(value);
  const result: SubscriberSnapshot = {
    id: text(data.id), accountNumber: text(data.accountNumber), displayName: text(data.displayName),
    villageName: text(data.villageName), meterNumber: text(data.meterNumber),
    readingHundredths: nonnegative(data.readingHundredths), balanceKopeks: integer(data.balanceKopeks),
    maintenanceBalanceKopeks: integer(data.maintenanceBalanceKopeks),
    verifiedReadingHundredths: nullableReading(data.verifiedReadingHundredths),
    verifiedAt: nullableTimestamp(data.verifiedAt), verifiedByTransactionId: nullableText(data.verifiedByTransactionId),
    waterTariffKopeks: nonnegative(data.waterTariffKopeks), drainageTariffKopeks: nonnegative(data.drainageTariffKopeks),
    hasWater: flag(data.hasWater), hasDrainage: flag(data.hasDrainage), version: nonnegative(data.version),
  };
  const verificationFields = [result.verifiedReadingHundredths, result.verifiedAt, result.verifiedByTransactionId];
  if (verificationFields.some(field => field === null) && verificationFields.some(field => field !== null)) return invalid();
  return result;
}

function state(value: unknown, signedReading = false): TransactionState {
  const data = object(value);
  return {
    balanceKopeks: integer(data.balanceKopeks), maintenanceBalanceKopeks: integer(data.maintenanceBalanceKopeks),
    readingHundredths: signedReading ? integer(data.readingHundredths) : nonnegative(data.readingHundredths),
  };
}
function tariff(value: unknown): TransactionTariff {
  const data = object(value);
  return {
    waterKopeks: nonnegative(data.waterKopeks), drainageKopeks: nonnegative(data.drainageKopeks),
    effectiveKopeks: nonnegative(data.effectiveKopeks), hasWater: flag(data.hasWater), hasDrainage: flag(data.hasDrainage),
  };
}
function payment(value: unknown): TransactionPayment | null {
  if (value === null) return null;
  const data = object(value);
  return {
    amountKopeks: nonnegative(data.amountKopeks), waterKopeks: nonnegative(data.waterKopeks),
    maintenanceKopeks: nonnegative(data.maintenanceKopeks), method: oneOf(data.method, ['cash', 'bank']),
    externalReference: nullableText(data.externalReference), purpose: nullableText(data.purpose),
  };
}
function verification(value: unknown): TransactionVerification | null {
  if (value === null) return null;
  const data = object(value);
  return {
    transactionId: text(data.transactionId), readingHundredths: nonnegative(data.readingHundredths),
    confirmedAt: timestamp(data.confirmedAt),
  };
}
function effect(value: unknown): TransactionEffect {
  const data = object(value);
  const kind: TransactionKind = oneOf(data.kind, [
    'payment', 'meter-reading', 'meter-reconciliation', 'recalculation', 'note', 'cancellation',
    'description-change', 'origin', 'maintenance-fee', 'maintenance-transfer', 'maintenance-fee-reversal',
    'maintenance-transfer-reversal', 'meter-replacement-closing', 'meter-replacement-reset',
  ]);
  const category: TransactionCategory = oneOf(data.category, ['system', 'cash', 'bank', 'recalculation', 'note']);
  return {
    kind, category, description: text(data.description), before: state(data.before),
    change: state(data.change, true), after: state(data.after), tariff: tariff(data.tariff), payment: payment(data.payment),
    confirmsReading: flag(data.confirmsReading), policyVersion: text(data.policyVersion),
  };
}
function createInput(value: unknown): CreateTransactionInput {
  const data = object(value);
  const submission = { subscriberId: text(data.subscriberId), expectedVersion: nonnegative(data.expectedVersion) };
  switch (data.kind) {
    case 'payment': return {
      ...submission, kind: data.kind, amount: text(data.amount), method: oneOf(data.method, ['cash', 'bank']),
      ...(data.externalReference === undefined ? {} : { externalReference: text(data.externalReference) }),
      ...(data.purpose === undefined ? {} : { purpose: text(data.purpose) }),
    };
    case 'reading': return {
      ...submission, kind: data.kind, reading: text(data.reading),
      ...(data.verified === undefined ? {} : { verified: flag(data.verified) }),
    };
    case 'reconciliation': return {
      ...submission, kind: data.kind, reading: text(data.reading), balance: text(data.balance),
      maintenanceBalance: text(data.maintenanceBalance), reason: text(data.reason),
    };
    case 'note': return { ...submission, kind: data.kind, description: text(data.description) };
    default: return invalid();
  }
}
function readingCalculation(value: unknown): ReadingCalculation {
  const data = object(value);
  return {
    subscriberId: text(data.subscriberId), accountNumber: text(data.accountNumber),
    previousReadingHundredths: nonnegative(data.previousReadingHundredths),
    newReadingHundredths: nonnegative(data.newReadingHundredths), consumptionHundredths: nonnegative(data.consumptionHundredths),
    waterTariffKopeks: nonnegative(data.waterTariffKopeks), drainageTariffKopeks: nonnegative(data.drainageTariffKopeks),
    effectiveTariffKopeks: nonnegative(data.effectiveTariffKopeks), hasWater: flag(data.hasWater), hasDrainage: flag(data.hasDrainage),
    chargeKopeks: nonnegative(data.chargeKopeks), balanceBeforeKopeks: integer(data.balanceBeforeKopeks),
    balanceAfterKopeks: integer(data.balanceAfterKopeks), subscriberVersion: nonnegative(data.subscriberVersion),
    policyVersion: text(data.policyVersion),
  };
}
function reading(value: unknown): ReadingRecord {
  const data = object(value);
  const input = object(data.originalInput);
  return {
    id: text(data.id), idempotencyKey: text(data.idempotencyKey),
    originalInput: { subscriberId: text(input.subscriberId), reading: text(input.reading), expectedVersion: nonnegative(input.expectedVersion) },
    actor: actor(data.actor), source: oneOf(data.source, ['demo-api']), createdAt: timestamp(data.createdAt),
    subscriberBefore: subscriber(data.subscriberBefore), calculation: readingCalculation(data.calculation),
  };
}
function request(value: unknown): TransactionRequest {
  const data = object(value);
  if (data.action === 'create') return { action: data.action, input: createInput(data.input) };
  if (data.action === 'reading-demo') return { action: data.action, reading: reading(data.reading) };
  const input = object(data.input);
  const command = { transactionId: text(data.transactionId), input: { expectedVersion: nonnegative(input.expectedVersion), reason: text(input.reason) } };
  if (data.action === 'cancel') return { ...command, action: data.action };
  if (data.action === 'amend') return { ...command, action: data.action, input: { ...command.input, description: text(input.description) } };
  return invalid();
}

function sameActor(left: RecordedActor, right: RecordedActor): boolean {
  return left.id === right.id && left.role === right.role && left.subscriberId === right.subscriberId;
}
function sameVerification(left: TransactionVerification | null, right: TransactionVerification | null): boolean {
  if (left === null || right === null) return left === right;
  return left.transactionId === right.transactionId && left.readingHundredths === right.readingHundredths && left.confirmedAt === right.confirmedAt;
}
function validateEvidence(record: TransactionRecord): void {
  const { effect: result, subscriberBefore: before, request: original } = record;
  if (before.id !== record.subscriberId || before.accountNumber !== record.accountNumber
    || result.before.balanceKopeks !== before.balanceKopeks
    || result.before.maintenanceBalanceKopeks !== before.maintenanceBalanceKopeks
    || result.before.readingHundredths !== before.readingHundredths) return invalid();
  for (const key of ['balanceKopeks', 'maintenanceBalanceKopeks', 'readingHundredths'] as const) {
    if (BigInt(result.before[key]) + BigInt(result.change[key]) !== BigInt(result.after[key])) return invalid();
  }
  if (result.tariff.waterKopeks !== before.waterTariffKopeks || result.tariff.drainageKopeks !== before.drainageTariffKopeks
    || result.tariff.hasWater !== before.hasWater || result.tariff.hasDrainage !== before.hasDrainage) return invalid();
  const originalVerification = before.verifiedByTransactionId === null ? null : {
    transactionId: before.verifiedByTransactionId, readingHundredths: before.verifiedReadingHundredths!, confirmedAt: before.verifiedAt!,
  };
  if (!sameVerification(record.verificationBefore, originalVerification)) return invalid();
  if (result.confirmsReading) {
    if (!sameVerification(record.verificationAfter, {
      transactionId: record.id, readingHundredths: result.after.readingHundredths, confirmedAt: record.createdAt,
    })) return invalid();
  } else if (original.action !== 'cancel' && !sameVerification(record.verificationAfter, record.verificationBefore)) return invalid();

  const recordedActor = normalizeRecordedActor(record.actor);
  if (!hasGeneralAccess(recordedActor)
    && !(recordedActor.role === 'guest' && recordedActor.subscriberId === record.subscriberId)) return invalid();
  if (original.action === 'cancel') {
    if (!hasGeneralAccess(recordedActor) || result.kind !== 'cancellation' || record.reversesId !== original.transactionId || record.amendsId !== null) return invalid();
  } else if (original.action === 'amend') {
    if (!hasGeneralAccess(recordedActor) || result.kind !== 'description-change' || record.amendsId !== original.transactionId || record.reversesId !== null) return invalid();
  } else {
    if (record.reversesId !== null || record.amendsId !== null) return invalid();
  }
  if (original.action !== 'reading-demo') {
    if (original.input.expectedVersion !== before.version) return invalid();
    if (original.action === 'create') {
      if (original.input.subscriberId !== record.subscriberId) return invalid();
      if (!hasGeneralAccess(recordedActor) && (original.input.kind !== 'reading' || original.input.verified)) return invalid();
      const allowed = {
        payment: ['payment'], reading: ['meter-reading', 'meter-reconciliation'],
        reconciliation: ['meter-reconciliation', 'recalculation'], note: ['note'],
      };
      if (!allowed[original.input.kind].includes(result.kind)) return invalid();
    }
  } else {
    const source = original.reading;
    if (source.id !== record.id || source.originalInput.subscriberId !== record.subscriberId
      || source.subscriberBefore.id !== record.subscriberId || source.calculation.subscriberId !== record.subscriberId
      || source.createdAt !== record.createdAt || !sameActor(source.actor, record.actor)
      || source.originalInput.expectedVersion !== before.version || source.calculation.subscriberVersion !== before.version
      || source.subscriberBefore.accountNumber !== record.accountNumber || source.calculation.accountNumber !== record.accountNumber
      || source.calculation.balanceBeforeKopeks !== result.before.balanceKopeks
      || source.calculation.previousReadingHundredths !== result.before.readingHundredths
      || source.calculation.waterTariffKopeks !== result.tariff.waterKopeks
      || source.calculation.drainageTariffKopeks !== result.tariff.drainageKopeks
      || source.calculation.effectiveTariffKopeks !== result.tariff.effectiveKopeks
      || source.calculation.hasWater !== result.tariff.hasWater || source.calculation.hasDrainage !== result.tariff.hasDrainage
      || result.kind !== 'meter-reading' || source.calculation.balanceAfterKopeks !== result.after.balanceKopeks
      || source.calculation.newReadingHundredths !== result.after.readingHundredths
      || source.calculation.chargeKopeks !== -result.change.balanceKopeks
      || source.calculation.consumptionHundredths !== result.change.readingHundredths
      || source.calculation.policyVersion !== result.policyVersion) return invalid();
  }
  if (result.payment !== null) {
    const paid = result.payment;
    if (original.action !== 'create' || original.input.kind !== 'payment' || result.kind !== 'payment'
      || paid.method !== original.input.method || result.category !== paid.method
      || paid.waterKopeks + paid.maintenanceKopeks !== paid.amountKopeks
      || paid.waterKopeks !== result.change.balanceKopeks || paid.maintenanceKopeks !== result.change.maintenanceBalanceKopeks
      || result.change.readingHundredths !== 0 || paid.amountKopeks === 0
      || (paid.method === 'bank' && !paid.externalReference)) return invalid();
  } else if (result.kind === 'payment') return invalid();
}

/** Validate persisted evidence without recalculating historical operations using today's business rules. */
export function readStoredTransaction(row: LedgerTransaction): TransactionRecord {
  const data = object(row.snapshot);
  const record: TransactionRecord = {
    id: text(data.id), sequence: nonnegative(row.sequence), idempotencyKey: text(data.idempotencyKey),
    subscriberId: text(data.subscriberId), accountNumber: text(data.accountNumber), actor: actor(data.actor),
    createdAt: timestamp(data.createdAt), effectiveAt: timestamp(data.effectiveAt), request: request(data.request),
    subscriberBefore: subscriber(data.subscriberBefore), effect: effect(data.effect),
    verificationBefore: verification(data.verificationBefore), verificationAfter: verification(data.verificationAfter),
    reversesId: nullableText(data.reversesId), amendsId: nullableText(data.amendsId),
  };
  const bankReference = record.effect.payment?.method === 'bank' ? record.effect.payment.externalReference : null;
  if (record.sequence < 1 || record.id !== row.id || record.idempotencyKey !== row.idempotencyKey
    || record.subscriberId !== row.subscriberId || record.createdAt !== row.createdAt.toISOString()
    || record.effectiveAt !== row.effectiveAt.toISOString() || record.reversesId !== row.reversesId
    || record.amendsId !== row.amendsId || bankReference !== row.bankReference) return invalid();
  validateEvidence(record);
  return record;
}
