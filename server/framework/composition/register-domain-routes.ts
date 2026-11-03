import type { FastifyInstance } from 'fastify';
import type { Application } from './create-application.js';
import { registerSubscriberRoutes } from '../../src/subscribers/SubscriberRoutes.js';
import { registerReadingRoutes } from '../../src/readings/ReadingRoutes.js';
import { registerTransactionRoutes } from '../../src/transactions/TransactionRoutes.js';
import { registerTaskRoutes } from '../../src/tasks/TaskRoutes.js';
import { requireActor } from '../core/actor.js';
import { registerUserRoutes } from '../../src/users/UserRoutes.js';
import type { UserCookieOptions } from '../../src/users/UserController.js';

export function registerDomainRoutes(server: FastifyInstance, application: Application, cookie: UserCookieOptions): void {
  // Subscribers publishes the Subscriber response schema also referenced by reading history.
  registerSubscriberRoutes(server, application.subscribers);
  registerReadingRoutes(server, application.readings);
  registerTransactionRoutes(server, application.transactions);
  registerTaskRoutes(server, application.tasks, (request) => requireActor(request.actor));
  registerUserRoutes(server, application.users, cookie);
}
