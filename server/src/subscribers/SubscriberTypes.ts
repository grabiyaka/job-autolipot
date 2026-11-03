import type { Actor } from '../../framework/core/actor.js';

export type SubscriberSnapshot = Readonly<{
  id: string;
  accountNumber: string;
  displayName: string;
  villageName: string;
  meterNumber: string;
  readingHundredths: number;
  balanceKopeks: number;
  maintenanceBalanceKopeks: number;
  verifiedReadingHundredths: number | null;
  verifiedAt: string | null;
  verifiedByTransactionId: string | null;
  waterTariffKopeks: number;
  drainageTariffKopeks: number;
  hasWater: boolean;
  hasDrainage: boolean;
  version: number;
}>;

export type ApplyMeterReading = Readonly<{
  subscriberId: string;
  expectedVersion: number;
  readingHundredths: number;
  balanceKopeks: number;
}>;

export interface SubscriberApi {
  listFor(actor: Actor): Promise<SubscriberSnapshot[]>;
  getById(subscriberId: string): Promise<SubscriberSnapshot>;
}

/** Granted by the composition root only inside a transaction that also records the reading. */
export interface SubscriberMeterStateWriter {
  applyMeterReading(change: ApplyMeterReading): Promise<void>;
}

export type ApplyLedgerState = ApplyMeterReading & Readonly<{
  maintenanceBalanceKopeks: number;
  verifiedReadingHundredths: number | null;
  verifiedAt: string | null;
  verifiedByTransactionId: string | null;
}>;

export interface SubscriberLedgerWriter {
  applyLedgerState(change: ApplyLedgerState): Promise<void>;
}
