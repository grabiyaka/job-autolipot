import type { FastifyInstance } from 'fastify';
import type { Actor } from '../framework/core/actor.js';
import type { UserSession } from '../src/users/UserTypes.js';

declare module 'fastify' {
  interface FastifyRequest { actor: Actor | null; authSession: UserSession | null }
}

export function registerRequestIdentity(server: FastifyInstance): void {
  server.decorateRequest('actor', null);
  server.decorateRequest('authSession', null);
}
