import type { FastifyRequest } from 'fastify';
import { requireActor } from '../../framework/core/actor.js';
import type { AnswerInput, ApplicationService } from './ApplicationService.js';

type IdParams = Readonly<{ id: string }>;

export class ApplicationController {
  constructor(private readonly applications: ApplicationService) {}

  list = async (request: FastifyRequest) => this.applications.list(requireActor(request.actor));

  get = async (request: FastifyRequest<{ Params: IdParams }>) => this.applications.get(requireActor(request.actor), request.params.id);

  submit = async (request: FastifyRequest<{ Params: IdParams }>) => this.applications.submitAs(requireActor(request.actor), request.params.id);

  answer = async (request: FastifyRequest<{ Params: IdParams; Body: AnswerInput }>) =>
    this.applications.answerAs(requireActor(request.actor), request.params.id, request.body);
}
