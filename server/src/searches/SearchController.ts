import type { FastifyReply, FastifyRequest } from 'fastify';
import { requireActor } from '../../framework/core/actor.js';
import type { SearchChange, SearchInput, SearchService } from './SearchService.js';

type SearchParams = Readonly<{ id: string }>;
export type SearchRunsQuerystring = Readonly<{ limit?: string }>;

export class SearchController {
  constructor(private readonly searches: SearchService) {}

  sources = async () => this.searches.sources();

  list = async (request: FastifyRequest) => this.searches.list(requireActor(request.actor));

  create = async (request: FastifyRequest<{ Body: SearchInput }>, reply: FastifyReply) => {
    const search = await this.searches.create(requireActor(request.actor), request.body);
    return reply.code(201).send(search);
  };

  update = async (request: FastifyRequest<{ Params: SearchParams; Body: SearchChange }>) =>
    this.searches.update(requireActor(request.actor), request.params.id, request.body);

  remove = async (request: FastifyRequest<{ Params: SearchParams }>, reply: FastifyReply) => {
    await this.searches.remove(requireActor(request.actor), request.params.id);
    return reply.code(204).send();
  };

  runs = async (request: FastifyRequest<{ Params: SearchParams; Querystring: SearchRunsQuerystring }>) =>
    this.searches.runs(
      requireActor(request.actor), request.params.id,
      request.query.limit === undefined ? undefined : Number(request.query.limit),
    );
}
