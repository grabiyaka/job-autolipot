import type { FastifyRequest } from 'fastify';
import { requireActor } from '../framework/core/actor.js';

export async function authenticatedAccess(request: FastifyRequest): Promise<void> {
  requireActor(request.actor);
}
