import type { FastifyInstance } from 'fastify';
import type { Application } from './create-application.js';
import { registerUserRoutes } from '../../src/users/UserRoutes.js';
import type { UserCookieOptions } from '../../src/users/UserController.js';

export function registerDomainRoutes(server: FastifyInstance, application: Application, cookie: UserCookieOptions): void {
  registerUserRoutes(server, application.users, cookie);
}
