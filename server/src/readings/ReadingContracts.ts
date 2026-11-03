import type { SubscriberMeterStateWriter, SubscriberApi } from '../subscribers/SubscriberTypes.js';
import type { ReadingRecord } from './ReadingTypes.js';
import type { TransactionReadingWriter } from '../transactions/TransactionTypes.js';

export interface ReadingRepositoryContract {
  findByIdempotencyKey(idempotencyKey: string): Promise<ReadingRecord | null>;
  save(record: ReadingRecord): Promise<void>;
  historyFor(subscriberId: string): Promise<ReadingRecord[]>;
}

export interface ReadingUnitOfWork {
  run<T>(operation: (dependencies: {
    subscribers: SubscriberApi & SubscriberMeterStateWriter;
    readings: ReadingRepositoryContract;
    transactions: TransactionReadingWriter;
  }) => Promise<T>): Promise<T>;
}
