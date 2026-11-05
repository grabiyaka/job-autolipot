import type { FastifyReply, FastifyRequest } from 'fastify';
import { requireActor } from '../../framework/core/actor.js';
import type { AnswerInput, AnswerService } from './AnswerService.js';

type AnswerParams = Readonly<{ id: string }>;

export class AnswerController {
  constructor(private readonly answers: AnswerService) {}

  list = async (request: FastifyRequest) => this.answers.list(requireActor(request.actor));

  put = async (request: FastifyRequest<{ Body: AnswerInput }>) => this.answers.put(requireActor(request.actor), request.body);

  remove = async (request: FastifyRequest<{ Params: AnswerParams }>, reply: FastifyReply) => {
    await this.answers.remove(requireActor(request.actor), request.params.id);
    return reply.code(204).send();
  };
}
