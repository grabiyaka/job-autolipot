import type { PrismaClient } from '../../generated/prisma/client.js';
import type { TransactionRepositoryContract } from './TransactionContracts.js';
import type { TransactionDraft, TransactionRecord } from './TransactionTypes.js';
import { readStoredTransaction } from './TransactionSnapshotMapper.js';

type Database = Pick<PrismaClient, 'ledgerTransaction'>;

export class TransactionRepository implements TransactionRepositoryContract {
  constructor(private readonly database: Database) {}

  async findById(id: string): Promise<TransactionRecord | null> {
    const row = await this.database.ledgerTransaction.findUnique({ where: { id } });
    return row ? readStoredTransaction(row) : null;
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<TransactionRecord | null> {
    const row = await this.database.ledgerTransaction.findUnique({ where: { idempotencyKey } });
    return row ? readStoredTransaction(row) : null;
  }

  async findBankPayment(subscriberId: string, bankReference: string): Promise<TransactionRecord | null> {
    const row = await this.database.ledgerTransaction.findUnique({
      where: { subscriberId_bankReference: { subscriberId, bankReference } },
    });
    return row ? readStoredTransaction(row) : null;
  }

  async historyFor(subscriberId: string): Promise<TransactionRecord[]> {
    const rows = await this.database.ledgerTransaction.findMany({
      where: { subscriberId }, orderBy: [{ effectiveAt: 'asc' }, { sequence: 'asc' }],
    });
    return rows.map(readStoredTransaction);
  }

  async all(): Promise<TransactionRecord[]> {
    const rows = await this.database.ledgerTransaction.findMany({ orderBy: [{ effectiveAt: 'asc' }, { sequence: 'asc' }] });
    return rows.map(readStoredTransaction);
  }

  async save(draft: TransactionDraft): Promise<TransactionRecord> {
    const row = await this.database.ledgerTransaction.create({
      data: {
        id: draft.id, idempotencyKey: draft.idempotencyKey, subscriberId: draft.subscriberId,
        createdAt: new Date(draft.createdAt), effectiveAt: new Date(draft.effectiveAt),
        snapshot: draft, reversesId: draft.reversesId, amendsId: draft.amendsId,
        bankReference: draft.effect.payment?.method === 'bank' ? draft.effect.payment.externalReference : null,
      },
    });
    return readStoredTransaction(row);
  }
}
