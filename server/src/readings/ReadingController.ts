import type { FastifyReply, FastifyRequest } from 'fastify';
import { requireActor } from '../../framework/core/actor.js';
import { ApplicationError } from '../../framework/core/errors.js';
import type { ReadingInput, ReadingApi, SubmitReadingInput } from './ReadingTypes.js';

export class ReadingController {
  constructor(private readonly readings: ReadingApi) {}

  preview = async (request: FastifyRequest<{ Body: ReadingInput }>) => ({
    calculation: await this.readings.preview(request.body, requireActor(request.actor)),
  });

  submit = async (request: FastifyRequest<{ Body: SubmitReadingInput }>, reply: FastifyReply) => {
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string') throw new ApplicationError('IDEMPOTENCY_KEY_REQUIRED', 'Нужен заголовок Idempotency-Key.', 400);
    const result = await this.readings.submit(request.body, requireActor(request.actor), key);
    return reply.code(result.replayed ? 200 : 201).send(result);
  };

  history = async (request: FastifyRequest<{ Params: { subscriberId: string } }>) => ({
    readings: await this.readings.history(request.params.subscriberId, requireActor(request.actor)),
  });
}
