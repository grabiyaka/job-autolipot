import { recordedActorRoles, type RecordedActor } from '../../framework/core/actor.js';
import type { Reading } from '../../generated/prisma/client.js';
import type { SubscriberSnapshot } from '../subscribers/SubscriberTypes.js';
import type { ReadingCalculation, ReadingRecord, SubmitReadingInput } from './ReadingTypes.js';

function invalidSnapshot(): never {
  throw new Error('Stored reading snapshot is invalid.');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function object(value: unknown): Record<string, unknown> {
  return isObject(value) ? value : invalidSnapshot();
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : invalidSnapshot();
}

function integer(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : invalidSnapshot();
}

function boolean(value: unknown): boolean {
  return typeof value === 'boolean' ? value : invalidSnapshot();
}

function actor(value: unknown): RecordedActor {
  const data = object(value);
  const role = data.role;
  const recordedRole = recordedActorRoles.find(candidate => candidate === role);
  if (recordedRole === undefined) return invalidSnapshot();
  return data.subscriberId === undefined
    ? { id: text(data.id), role: recordedRole }
    : { id: text(data.id), role: recordedRole, subscriberId: text(data.subscriberId) };
}

function input(value: unknown): SubmitReadingInput {
  const data = object(value);
  return {
    subscriberId: text(data.subscriberId),
    reading: text(data.reading),
    expectedVersion: integer(data.expectedVersion),
  };
}

function subscriber(value: unknown): SubscriberSnapshot {
  const data = object(value);
  return {
    id: text(data.id),
    accountNumber: text(data.accountNumber),
    displayName: text(data.displayName),
    villageName: text(data.villageName),
    meterNumber: text(data.meterNumber),
    readingHundredths: integer(data.readingHundredths),
    balanceKopeks: integer(data.balanceKopeks),
    // These fields did not exist in the first immutable reading snapshot format.
    maintenanceBalanceKopeks: data.maintenanceBalanceKopeks === undefined ? 0 : integer(data.maintenanceBalanceKopeks),
    verifiedReadingHundredths: data.verifiedReadingHundredths === undefined || data.verifiedReadingHundredths === null
      ? null : integer(data.verifiedReadingHundredths),
    verifiedAt: data.verifiedAt === undefined || data.verifiedAt === null ? null : text(data.verifiedAt),
    verifiedByTransactionId: data.verifiedByTransactionId === undefined || data.verifiedByTransactionId === null
      ? null : text(data.verifiedByTransactionId),
    waterTariffKopeks: integer(data.waterTariffKopeks),
    drainageTariffKopeks: integer(data.drainageTariffKopeks),
    hasWater: boolean(data.hasWater),
    hasDrainage: boolean(data.hasDrainage),
    version: integer(data.version),
  };
}

function calculation(value: unknown): ReadingCalculation {
  const data = object(value);
  return {
    subscriberId: text(data.subscriberId),
    accountNumber: text(data.accountNumber),
    previousReadingHundredths: integer(data.previousReadingHundredths),
    newReadingHundredths: integer(data.newReadingHundredths),
    consumptionHundredths: integer(data.consumptionHundredths),
    waterTariffKopeks: integer(data.waterTariffKopeks),
    drainageTariffKopeks: integer(data.drainageTariffKopeks),
    effectiveTariffKopeks: integer(data.effectiveTariffKopeks),
    hasWater: boolean(data.hasWater),
    hasDrainage: boolean(data.hasDrainage),
    chargeKopeks: integer(data.chargeKopeks),
    balanceBeforeKopeks: integer(data.balanceBeforeKopeks),
    balanceAfterKopeks: integer(data.balanceAfterKopeks),
    subscriberVersion: integer(data.subscriberVersion),
    policyVersion: text(data.policyVersion),
  };
}

// Database JSON is untrusted at the boundary, including data from older deployments.
// Decode the stored result; never recalculate historical bills with today's policy.
export function readStoredReading(row: Reading): ReadingRecord {
  const data = object(row.snapshot);
  if (data.source !== 'demo-api') return invalidSnapshot();

  const result: ReadingRecord = {
    id: text(data.id),
    idempotencyKey: text(data.idempotencyKey),
    originalInput: input(data.originalInput),
    actor: actor(data.actor),
    source: data.source,
    createdAt: text(data.createdAt),
    subscriberBefore: subscriber(data.subscriberBefore),
    calculation: calculation(data.calculation),
  };

  if (
    result.id !== row.id ||
    result.idempotencyKey !== row.idempotencyKey ||
    result.originalInput.subscriberId !== row.subscriberId ||
    result.subscriberBefore.id !== row.subscriberId ||
    result.calculation.subscriberId !== row.subscriberId ||
    result.createdAt !== row.createdAt.toISOString()
  ) return invalidSnapshot();

  return result;
}
