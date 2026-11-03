import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import { ApplicationError } from '../core/errors.js';
import type { TransactionRepositoryContract, TransactionUnitOfWork } from '../../src/transactions/TransactionContracts.js';
import { TransactionRepository } from '../../src/transactions/TransactionRepository.js';
import { SubscriberService } from '../../src/subscribers/SubscriberService.js';
import { SubscriberRepository } from '../../src/subscribers/SubscriberRepository.js';
import type { SubscriberApi, SubscriberLedgerWriter } from '../../src/subscribers/SubscriberTypes.js';

export class PrismaTransactionUnitOfWork implements TransactionUnitOfWork {
  constructor(private readonly database: PrismaClient) {}

  async run<T>(subscriberId: string, operation: (dependencies: {
    subscribers: SubscriberApi & SubscriberLedgerWriter;
    transactions: TransactionRepositoryContract;
  }) => Promise<T>): Promise<T> {
    try {
      return await this.database.$transaction(async (transaction) => {
        // Serialize account changes before reading state or history: reversals and
        // duplicate requests must see the previous committed operation in full.
        await transaction.$queryRaw`SELECT "id" FROM "subscribers" WHERE "id" = ${subscriberId} FOR UPDATE`;
        const subscribers = new SubscriberService(new SubscriberRepository(transaction));
        const transactions = new TransactionRepository(transaction);
        return operation({ subscribers, transactions });
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && ['P2034', 'P2002'].includes(error.code)) {
        throw new ApplicationError('STATE_CHANGED', 'Данные абонента изменились. Обновите расчёт.', 409);
      }
      throw error;
    }
  }
}
