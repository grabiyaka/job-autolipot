import { ensureSubscriberAccess, type Actor } from '../../framework/core/actor.js';
import { ApplicationError } from '../../framework/core/errors.js';
import type { Clock, Identifiers } from '../../framework/core/runtime.js';
import type { ReadingRecord } from '../readings/ReadingTypes.js';
import type { SubscriberApi, SubscriberSnapshot } from '../subscribers/SubscriberTypes.js';
import type { TransactionRepositoryContract, TransactionUnitOfWork } from './TransactionContracts.js';
import { presentTransactions, verificationAfterCancellation } from './TransactionHistory.js';
import {
  ensureTransactionCreationAccess, ensureTransactionVersion, ensureValidTransactionSubmission,
  ledgerStateAfter, prepareReadingTransaction, prepareTransaction, replayTransaction, requireTransactionGeneralAccess,
} from './TransactionOperation.js';
import { TransactionQuery } from './TransactionQuery.js';
import { calculateCancellation, calculateDescriptionChange, calculateTransaction } from './TransactionRules.js';
import type {
  AmendTransactionInput, CancelTransactionInput, CreateTransactionInput, TransactionApi,
  TransactionEffect, TransactionListInput, TransactionPage, TransactionReadingWriter,
  TransactionRecord, TransactionRequest, TransactionResult, TransactionVerification, TransactionView,
} from './TransactionTypes.js';

type Command = Exclude<TransactionRequest, Readonly<{ action: 'reading-demo'; reading: ReadingRecord }>>;
type Outcome = Readonly<{ effect: TransactionEffect; verification?: TransactionVerification | null }>;

export class TransactionService implements TransactionApi, TransactionReadingWriter {
  constructor(
    private readonly subscribers: SubscriberApi,
    private readonly transactions: TransactionRepositoryContract,
    private readonly unitOfWork: TransactionUnitOfWork,
    private readonly clock: Clock,
    private readonly identifiers: Identifiers,
  ) {}

  async preview(input: CreateTransactionInput, actor: Actor): Promise<TransactionEffect> {
    ensureTransactionCreationAccess(input, actor);
    const subscriber = await this.subscribers.getById(input.subscriberId);
    return calculateTransaction(subscriber, input, actor);
  }

  async create(input: CreateTransactionInput, actor: Actor, idempotencyKey: string): Promise<TransactionResult> {
    ensureTransactionCreationAccess(input, actor);
    ensureValidTransactionSubmission(input.expectedVersion, idempotencyKey);
    return this.execute({ action: 'create', input }, input.subscriberId, actor, `transactions:${idempotencyKey}`);
  }

  async list(input: TransactionListInput, actor: Actor): Promise<TransactionPage> {
    const query = new TransactionQuery(input, actor);
    const records = await this.recordsFor(query);
    return query.paginate(presentTransactions(records));
  }

  async getById(id: string, actor: Actor): Promise<TransactionView> {
    const source = await this.requiredTransaction(id, this.transactions);
    ensureSubscriberAccess(actor, source.subscriberId);
    const history = await this.transactions.historyFor(source.subscriberId);
    const view = presentTransactions(history).find((item) => item.record.id === id);
    if (!view) throw this.notFound();
    return view;
  }

  async cancel(id: string, input: CancelTransactionInput, actor: Actor, idempotencyKey: string): Promise<TransactionResult> {
    requireTransactionGeneralAccess(actor);
    ensureValidTransactionSubmission(input.expectedVersion, idempotencyKey);
    const source = await this.requiredTransaction(id, this.transactions);
    return this.execute({ action: 'cancel', transactionId: id, input }, source.subscriberId, actor, `transactions:${idempotencyKey}`);
  }

  async amendDescription(id: string, input: AmendTransactionInput, actor: Actor, idempotencyKey: string): Promise<TransactionResult> {
    requireTransactionGeneralAccess(actor);
    ensureValidTransactionSubmission(input.expectedVersion, idempotencyKey);
    const source = await this.requiredTransaction(id, this.transactions);
    return this.execute({ action: 'amend', transactionId: id, input }, source.subscriberId, actor, `transactions:${idempotencyKey}`);
  }

  async exportCsv(input: TransactionListInput, actor: Actor): Promise<string> {
    requireTransactionGeneralAccess(actor);
    const query = new TransactionQuery(input, actor);
    return query.exportCsv(presentTransactions(await this.recordsFor(query)));
  }

  /** The reading unit of work already applies subscriber state; this capability only appends evidence. */
  async recordReading(record: ReadingRecord): Promise<void> {
    const draft = prepareReadingTransaction(record);
    const existing = await this.transactions.findByIdempotencyKey(draft.idempotencyKey);
    if (existing) {
      replayTransaction(existing, draft.request, draft.actor);
      return;
    }
    await this.transactions.save(draft);
  }

  private async execute(request: Command, subscriberId: string, actor: Actor, idempotencyKey: string): Promise<TransactionResult> {
    const existing = await this.transactions.findByIdempotencyKey(idempotencyKey);
    if (existing) return replayTransaction(existing, request, actor);

    try {
      return await this.unitOfWork.run(subscriberId, async ({ subscribers, transactions }) => {
        const replay = await transactions.findByIdempotencyKey(idempotencyKey);
        if (replay) return replayTransaction(replay, request, actor);

        const subscriber = await subscribers.getById(subscriberId);
        ensureTransactionVersion(subscriber, request.input.expectedVersion);
        const outcome = await this.calculate(request, subscriber, actor, transactions);
        const draft = prepareTransaction(
          subscriber, request, outcome.effect, actor, idempotencyKey,
          this.identifiers.next(), this.clock.now().toISOString(), outcome.verification,
        );

        await subscribers.applyLedgerState(ledgerStateAfter(draft));
        const record = await transactions.save(draft);
        return { record, replayed: false };
      });
    } catch (error) {
      const committed = await this.transactions.findByIdempotencyKey(idempotencyKey);
      if (committed) return replayTransaction(committed, request, actor);
      throw error;
    }
  }

  private async calculate(
    request: Command, subscriber: SubscriberSnapshot, actor: Actor, transactions: TransactionRepositoryContract,
  ): Promise<Outcome> {
    if (request.action === 'create') {
      const effect = calculateTransaction(subscriber, request.input, actor);
      await this.ensureNewBankReference(subscriber.id, effect, transactions);
      return { effect };
    }

    const source = await this.requiredTransaction(request.transactionId, transactions);
    if (source.subscriberId !== subscriber.id) throw this.notFound();
    const history = await transactions.historyFor(subscriber.id);
    if (request.action === 'cancel') {
      return {
        effect: calculateCancellation(subscriber, source, history, request.input.reason),
        verification: verificationAfterCancellation(history, source),
      };
    }

    if (typeof request.input.reason !== 'string' || !request.input.reason.trim() || request.input.reason.length > 2_000) {
      throw new ApplicationError('INVALID_REASON', 'Укажите причину изменения описания, до 2000 символов.', 400);
    }
    if (history.some((record) => record.reversesId === source.id)) {
      throw new ApplicationError('TRANSACTION_CANCELLED', 'Описание отменённой операции нельзя изменить.', 409);
    }
    return { effect: calculateDescriptionChange(subscriber, source, request.input.description) };
  }

  private async ensureNewBankReference(
    subscriberId: string, effect: TransactionEffect, transactions: TransactionRepositoryContract,
  ): Promise<void> {
    const payment = effect.payment;
    if (payment?.method !== 'bank' || !payment.externalReference) return;
    if (await transactions.findBankPayment(subscriberId, payment.externalReference)) {
      throw new ApplicationError('BANK_REFERENCE_CONFLICT', 'Банковский платёж с этим идентификатором уже учтён.', 409);
    }
  }

  private async recordsFor(query: TransactionQuery): Promise<TransactionRecord[]> {
    if (query.subscriberId === undefined) return this.transactions.all();
    await this.subscribers.getById(query.subscriberId);
    return this.transactions.historyFor(query.subscriberId);
  }

  private async requiredTransaction(id: string, transactions: TransactionRepositoryContract): Promise<TransactionRecord> {
    const record = await transactions.findById(id);
    if (!record) throw this.notFound();
    return record;
  }

  private notFound(): ApplicationError {
    return new ApplicationError('TRANSACTION_NOT_FOUND', 'Операция не найдена.', 404);
  }
}
