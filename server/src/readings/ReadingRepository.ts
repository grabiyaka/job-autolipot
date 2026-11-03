import type { PrismaClient } from '../../generated/prisma/client.js';
import type { ReadingRepositoryContract } from './ReadingContracts.js';
import type { ReadingRecord } from './ReadingTypes.js';
import { readStoredReading } from './ReadingSnapshotMapper.js';

type Database = Pick<PrismaClient, 'reading'>;

export class ReadingRepository implements ReadingRepositoryContract {
  constructor(private readonly database: Database) {}

  async findByIdempotencyKey(idempotencyKey: string): Promise<ReadingRecord | null> {
    const row = await this.database.reading.findUnique({ where: { idempotencyKey } });
    return row === null ? null : readStoredReading(row);
  }

  async save(record: ReadingRecord): Promise<void> {
    await this.database.reading.create({
      data: {
        id: record.id,
        idempotencyKey: record.idempotencyKey,
        subscriberId: record.calculation.subscriberId,
        createdAt: new Date(record.createdAt),
        snapshot: record,
      },
    });
  }

  async historyFor(subscriberId: string): Promise<ReadingRecord[]> {
    const rows = await this.database.reading.findMany({
      where: { subscriberId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return rows.map(readStoredReading);
  }
}
