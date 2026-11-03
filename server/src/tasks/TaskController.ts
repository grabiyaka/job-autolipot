// <framework:generated sha256=18e5ec5beff39e8211ecd7e6c23d370a7c846936c6709bba9c33ece6d3f60e5b>
import type { FastifyRequest, FastifyReply } from 'fastify';
import type { TaskApi, CreateTaskInput, UpdateTaskInput } from './TaskTypes.js';

export class GeneratedTaskController<Context> {
  constructor(
    protected readonly api: TaskApi<Context>,
    protected readonly context: (request: FastifyRequest) => Context | Promise<Context>,
  ) {}

  list = async (request: FastifyRequest<{ Querystring: { page?: string; limit?: string } }>) =>
    this.api.list({
      ...(request.query.page !== undefined ? { page: Number(request.query.page) } : {}),
      ...(request.query.limit !== undefined ? { limit: Number(request.query.limit) } : {}),
    }, await this.context(request));

  get = async (request: FastifyRequest<{ Params: { id: string } }>) =>
    this.api.get(request.params.id, await this.context(request));

  create = async (request: FastifyRequest<{ Body: CreateTaskInput }>, reply: FastifyReply) =>
    reply.code(201).send(await this.api.create(request.body, await this.context(request)));

  update = async (request: FastifyRequest<{ Params: { id: string }; Body: UpdateTaskInput }>) =>
    this.api.update(request.params.id, request.body, await this.context(request));

  delete = async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    await this.api.delete(request.params.id, await this.context(request));
    return reply.code(204).send();
  };
}
// </framework:generated>
// Add custom HTTP handlers here. This section is preserved during generation.
export class TaskController<Context> extends GeneratedTaskController<Context> {}
