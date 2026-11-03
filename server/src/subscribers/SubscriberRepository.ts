import type { PrismaClient } from '../../generated/prisma/client.js';
import type { SubscriberRepositoryContract } from './SubscriberContracts.js';
import type { ApplyLedgerState, ApplyMeterReading, SubscriberSnapshot } from './SubscriberTypes.js';

// Both PrismaClient and Prisma.TransactionClient provide this delegate.
type Database = Pick<PrismaClient, 'subscriber'>;

export class SubscriberRepository implements SubscriberRepositoryContract {
  constructor(private readonly database: Database) {}

  async list(): Promise<SubscriberSnapshot[]> {
    return this.database.subscriber.findMany({ orderBy: { accountNumber: 'asc' } });
  }

  async findById(subscriberId: string): Promise<SubscriberSnapshot | null> {
    return this.database.subscriber.findUnique({ where: { id: subscriberId } });
  }

  async updateMeterState(change: ApplyMeterReading): Promise<boolean> {
    const result = await this.database.subscriber.updateMany({
      where: { id: change.subscriberId, version: change.expectedVersion },
      data: {
        readingHundredths: change.readingHundredths,
        balanceKopeks: change.balanceKopeks,
        version: { increment: 1 },
      },
    });
    return result.count === 1;
  }

  async updateLedgerState(change: ApplyLedgerState): Promise<boolean> {
    const result = await this.database.subscriber.updateMany({
      where: { id: change.subscriberId, version: change.expectedVersion },
      data: {
        readingHundredths: change.readingHundredths,
        balanceKopeks: change.balanceKopeks,
        maintenanceBalanceKopeks: change.maintenanceBalanceKopeks,
        verifiedReadingHundredths: change.verifiedReadingHundredths,
        verifiedAt: change.verifiedAt,
        verifiedByTransactionId: change.verifiedByTransactionId,
        version: { increment: 1 },
      },
    });
    return result.count === 1;
  }
}
