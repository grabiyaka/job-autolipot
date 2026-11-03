import type { Actor, RecordedActor } from '../../framework/core/actor.js';
import type { ReadingRecord } from '../readings/ReadingTypes.js';
import type { SubscriberSnapshot } from '../subscribers/SubscriberTypes.js';

export type TransactionState = Readonly<{
  balanceKopeks: number;
  maintenanceBalanceKopeks: number;
  readingHundredths: number;
}>;

export type TransactionVerification = Readonly<{
  transactionId: string;
  readingHundredths: number;
  confirmedAt: string;
}>;

type Submission = Readonly<{ subscriberId: string; expectedVersion: number }>;
export type PaymentInput = Submission & Readonly<{
  kind: 'payment'; amount: string; method: 'cash' | 'bank';
  externalReference?: string; purpose?: string;
}>;
export type TransactionReadingInput = Submission & Readonly<{
  kind: 'reading'; reading: string; verified?: boolean;
}>;
export type ReconciliationInput = Submission & Readonly<{
  kind: 'reconciliation'; reading: string;
  balance: string; maintenanceBalance: string; reason: string;
}>;
export type TransactionNoteInput = Submission & Readonly<{ kind: 'note'; description: string }>;
export type CreateTransactionInput = PaymentInput | TransactionReadingInput | ReconciliationInput | TransactionNoteInput;
export type CancelTransactionInput = Readonly<{ expectedVersion: number; reason: string }>;
export type AmendTransactionInput = Readonly<{ expectedVersion: number; description: string; reason: string }>;

export type TransactionKind = 'payment' | 'meter-reading' | 'meter-reconciliation' | 'recalculation'
  | 'note' | 'cancellation' | 'description-change' | 'origin'
  | 'maintenance-fee' | 'maintenance-transfer' | 'maintenance-fee-reversal' | 'maintenance-transfer-reversal'
  | 'meter-replacement-closing' | 'meter-replacement-reset';
export type TransactionCategory = 'system' | 'cash' | 'bank' | 'recalculation' | 'note';
export type TransactionTariff = Readonly<{
  waterKopeks: number; drainageKopeks: number; effectiveKopeks: number;
  hasWater: boolean; hasDrainage: boolean;
}>;
export type TransactionPayment = Readonly<{
  amountKopeks: number; waterKopeks: number; maintenanceKopeks: number;
  method: 'cash' | 'bank'; externalReference: string | null; purpose: string | null;
}>;

export type TransactionEffect = Readonly<{
  kind: TransactionKind;
  category: TransactionCategory;
  description: string;
  before: TransactionState;
  change: TransactionState;
  after: TransactionState;
  tariff: TransactionTariff;
  payment: TransactionPayment | null;
  confirmsReading: boolean;
  policyVersion: string;
}>;

export type TransactionRequest =
  | Readonly<{ action: 'create'; input: CreateTransactionInput }>
  | Readonly<{ action: 'cancel'; transactionId: string; input: CancelTransactionInput }>
  | Readonly<{ action: 'amend'; transactionId: string; input: AmendTransactionInput }>
  | Readonly<{ action: 'reading-demo'; reading: ReadingRecord }>;

/** Immutable execution evidence. Later changes are linked records, never updates of this record. */
export type TransactionDraft = Readonly<{
  id: string; idempotencyKey: string;
  subscriberId: string; accountNumber: string;
  actor: RecordedActor; createdAt: string; effectiveAt: string;
  request: TransactionRequest;
  subscriberBefore: SubscriberSnapshot;
  effect: TransactionEffect;
  verificationBefore: TransactionVerification | null;
  verificationAfter: TransactionVerification | null;
  reversesId: string | null;
  amendsId: string | null;
}>;
export type TransactionRecord = TransactionDraft & Readonly<{ sequence: number }>;
export type TransactionView = Readonly<{
  record: TransactionRecord;
  description: string;
  cancelledBy: string | null;
  projection: Readonly<{ before: TransactionState; after: TransactionState }>;
}>;
export type TransactionListInput = Readonly<{
  subscriberId?: string; kind?: TransactionKind;
  from?: string; to?: string; search?: string;
  page?: number; limit?: number; order?: 'asc' | 'desc';
}>;
export type TransactionPage = Readonly<{ items: TransactionView[]; total: number; page: number; limit: number }>;
export type TransactionResult = Readonly<{ record: TransactionRecord; replayed: boolean }>;

export interface TransactionApi {
  preview(input: CreateTransactionInput, actor: Actor): Promise<TransactionEffect>;
  create(input: CreateTransactionInput, actor: Actor, idempotencyKey: string): Promise<TransactionResult>;
  list(input: TransactionListInput, actor: Actor): Promise<TransactionPage>;
  getById(id: string, actor: Actor): Promise<TransactionView>;
  cancel(id: string, input: CancelTransactionInput, actor: Actor, idempotencyKey: string): Promise<TransactionResult>;
  amendDescription(id: string, input: AmendTransactionInput, actor: Actor, idempotencyKey: string): Promise<TransactionResult>;
  exportCsv(input: TransactionListInput, actor: Actor): Promise<string>;
}

/** Granted only inside the reading transaction; it records evidence without applying the charge twice. */
export interface TransactionReadingWriter {
  recordReading(record: ReadingRecord): Promise<void>;
}
