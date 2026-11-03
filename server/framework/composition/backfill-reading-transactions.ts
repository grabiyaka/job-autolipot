import type { PrismaClient } from '../../generated/prisma/client.js';
import { readStoredReading } from '../../src/readings/ReadingSnapshotMapper.js';
import { prepareReadingTransaction, replayTransaction } from '../../src/transactions/TransactionOperation.js';
import { TransactionRepository } from '../../src/transactions/TransactionRepository.js';

/** Add journal evidence for the older demo without changing subscriber balances or original readings. */
export async function backfillReadingTransactions(database: PrismaClient): Promise<number> {
  const transactions = new TransactionRepository(database);
  const readings = await database.reading.findMany({ orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  let added = 0;
  for (const row of readings) {
    const draft = prepareReadingTransaction(readStoredReading(row));
    const existing = await transactions.findByIdempotencyKey(draft.idempotencyKey);
    if (existing) {
      replayTransaction(existing, draft.request, draft.actor);
      continue;
    }
    await transactions.save(draft);
    added += 1;
  }
  return added;
}
