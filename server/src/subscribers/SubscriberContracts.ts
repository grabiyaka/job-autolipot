import type { ApplyLedgerState, ApplyMeterReading, SubscriberSnapshot } from './SubscriberTypes.js';

export interface SubscriberRepositoryContract {
  list(): Promise<SubscriberSnapshot[]>;
  findById(subscriberId: string): Promise<SubscriberSnapshot | null>;
  updateMeterState(change: ApplyMeterReading): Promise<boolean>;
  updateLedgerState(change: ApplyLedgerState): Promise<boolean>;
}
