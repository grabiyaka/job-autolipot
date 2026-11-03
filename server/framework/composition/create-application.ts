import type { PrismaClient } from '../../generated/prisma/client.js';
import type { Clock, Identifiers } from '../core/runtime.js';
import type { SubscriberApi } from '../../src/subscribers/SubscriberTypes.js';
import type { ReadingApi } from '../../src/readings/ReadingTypes.js';
import { SubscriberService } from '../../src/subscribers/SubscriberService.js';
import { ReadingService } from '../../src/readings/ReadingService.js';
import { SubscriberRepository } from '../../src/subscribers/SubscriberRepository.js';
import { ReadingRepository } from '../../src/readings/ReadingRepository.js';
import { PrismaReadingUnitOfWork } from './prisma-reading-unit-of-work.js';
import type { TransactionApi } from '../../src/transactions/TransactionTypes.js';
import { TransactionService } from '../../src/transactions/TransactionService.js';
import { TransactionRepository } from '../../src/transactions/TransactionRepository.js';
import { PrismaTransactionUnitOfWork } from './prisma-transaction-unit-of-work.js';
import type { Actor } from '../core/actor.js';
import { requireRole } from '../core/roles.js';
import type { TaskApi } from '../../src/tasks/TaskTypes.js';
import { TaskService } from '../../src/tasks/TaskService.js';
import { TaskRepository } from '../../src/tasks/TaskRepository.js';
import { UserService } from '../../src/users/UserService.js';
import { UserRepository } from '../../src/users/UserRepository.js';
import type { UserApi } from '../../src/users/UserTypes.js';
import { ScryptPasswords } from '../../plugins/passwords.js';

export interface Application {
  subscribers: SubscriberApi;
  readings: ReadingApi;
  transactions: TransactionApi;
  tasks: TaskApi<Actor>;
  users: UserApi;
}

// Only the composition root knows concrete repositories. HTTP receives public APIs.
export function createApplication(prisma: PrismaClient, clock: Clock, identifiers: Identifiers, sessionTtlSeconds = 3600): Application {
  const subscribers = new SubscriberService(new SubscriberRepository(prisma));
  const readings = new ReadingService(
    subscribers,
    new ReadingRepository(prisma),
    new PrismaReadingUnitOfWork(prisma, clock, identifiers),
    clock,
    identifiers,
  );
  const transactions = new TransactionService(
    subscribers, new TransactionRepository(prisma),
    new PrismaTransactionUnitOfWork(prisma), clock, identifiers,
  );
  // The application chooses access rules; the generated CRUD has no built-in roles.
  const tasks = new TaskService(new TaskRepository(prisma), (operation, actor: Actor) => {
    if (operation === 'list' || operation === 'get') requireRole(actor, 'admin', 'manager', 'guest');
    else if (operation === 'delete') requireRole(actor, 'admin');
    else requireRole(actor, 'admin', 'manager');
  });
  const users = new UserService(new UserRepository(prisma), new ScryptPasswords(), clock, identifiers, sessionTtlSeconds);
  return { subscribers, readings, transactions, tasks, users };
}
