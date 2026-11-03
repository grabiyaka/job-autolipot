import type { SubscriberApi, SubscriberLedgerWriter } from '../subscribers/SubscriberTypes.js';
import type { TransactionDraft, TransactionRecord } from './TransactionTypes.js';

export interface TransactionRepositoryContract {
  findById(id: string): Promise<TransactionRecord | null>;
  findByIdempotencyKey(key: string): Promise<TransactionRecord | null>;
  findBankPayment(subscriberId: string, externalReference: string): Promise<TransactionRecord | null>;
  historyFor(subscriberId: string): Promise<TransactionRecord[]>;
  all(): Promise<TransactionRecord[]>;
  save(draft: TransactionDraft): Promise<TransactionRecord>;
}

export interface TransactionUnitOfWork {
  run<T>(subscriberId: string, operation: (dependencies: {
    subscribers: SubscriberApi & SubscriberLedgerWriter;
    transactions: TransactionRepositoryContract;
  }) => Promise<T>): Promise<T>;
}
