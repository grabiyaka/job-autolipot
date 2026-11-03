import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import { ApplicationError } from '../core/errors.js';
import type { ReadingUnitOfWork } from '../../src/readings/ReadingContracts.js';
import type { ReadingRepositoryContract } from '../../src/readings/ReadingContracts.js';
import { ReadingRepository } from '../../src/readings/ReadingRepository.js';
import { SubscriberService } from '../../src/subscribers/SubscriberService.js';
import { SubscriberRepository } from '../../src/subscribers/SubscriberRepository.js';
import type { SubscriberMeterStateWriter, SubscriberApi } from '../../src/subscribers/SubscriberTypes.js';
import type { Clock, Identifiers } from '../core/runtime.js';
import type { TransactionReadingWriter } from '../../src/transactions/TransactionTypes.js';
import { TransactionRepository } from '../../src/transactions/TransactionRepository.js';
import { TransactionService } from '../../src/transactions/TransactionService.js';
import { PrismaTransactionUnitOfWork } from './prisma-transaction-unit-of-work.js';

export class PrismaReadingUnitOfWork implements ReadingUnitOfWork {
  constructor(
    private readonly database: PrismaClient,
    private readonly clock: Clock,
    private readonly identifiers: Identifiers,
  ) {}

  async run<T>(operation: (dependencies: {
    subscribers: SubscriberApi & SubscriberMeterStateWriter;
    readings: ReadingRepositoryContract;
    transactions: TransactionReadingWriter;
  }) => Promise<T>): Promise<T> {
    try {
      return await this.database.$transaction(async (transaction) => {
        const subscribers = new SubscriberService(new SubscriberRepository(transaction));
        const readings = new ReadingRepository(transaction);
        const transactions = new TransactionService(
          subscribers, new TransactionRepository(transaction),
          new PrismaTransactionUnitOfWork(this.database), this.clock, this.identifiers,
        );
        return operation({ subscribers, readings, transactions });
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') {
        throw new ApplicationError('STATE_CHANGED', 'Данные абонента изменились. Обновите расчёт.', 409);
      }
      throw error;
    }
  }
}
