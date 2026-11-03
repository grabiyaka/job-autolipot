import type { FastifyRequest } from 'fastify';
import { requireActor } from '../../framework/core/actor.js';
import type { SubscriberApi } from './SubscriberTypes.js';

export class SubscriberController {
  constructor(private readonly subscribers: SubscriberApi) {}

  list = async (request: FastifyRequest) => ({
    subscribers: await this.subscribers.listFor(requireActor(request.actor)),
  });
}
