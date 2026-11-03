import type { FastifyReply, FastifyRequest } from 'fastify';
import { requireActor } from '../../framework/core/actor.js';
import type { JobInput, JobListQuery, JobService, JobStatus, UserJobStatus } from './JobService.js';

export type JobCreateBody = Omit<JobInput, 'source' | 'raw' | 'postedAt' | 'externalId' | 'rejection'> & { source?: string };

export type JobListQuerystring = Readonly<{
  page?: string; limit?: string; status?: JobStatus; source?: string; search?: string; sort?: 'found' | 'score';
}>;
type JobParams = Readonly<{ id: string }>;

function listQuery(query: JobListQuerystring): JobListQuery {
  return {
    ...(query.page !== undefined ? { page: Number(query.page) } : {}),
    ...(query.limit !== undefined ? { limit: Number(query.limit) } : {}),
    ...(query.status !== undefined ? { status: query.status } : {}),
    ...(query.source !== undefined ? { source: query.source } : {}),
    ...(query.search !== undefined ? { search: query.search } : {}),
    ...(query.sort !== undefined ? { sort: query.sort } : {}),
  };
}

export class JobController {
  constructor(private readonly jobs: JobService) {}

  list = async (request: FastifyRequest<{ Querystring: JobListQuerystring }>) =>
    this.jobs.list(requireActor(request.actor), listQuery(request.query));

  summary = async (request: FastifyRequest) => this.jobs.summary(requireActor(request.actor));

  get = async (request: FastifyRequest<{ Params: JobParams }>) =>
    this.jobs.get(requireActor(request.actor), request.params.id);

  create = async (request: FastifyRequest<{ Body: JobCreateBody }>, reply: FastifyReply) => {
    const job = await this.jobs.create(requireActor(request.actor), request.body);
    return reply.code(201).send(job);
  };

  changeStatus = async (request: FastifyRequest<{ Params: JobParams; Body: { status: UserJobStatus } }>) =>
    this.jobs.changeStatus(requireActor(request.actor), request.params.id, request.body.status);

  remove = async (request: FastifyRequest<{ Params: JobParams }>, reply: FastifyReply) => {
    await this.jobs.remove(requireActor(request.actor), request.params.id);
    return reply.code(204).send();
  };
}
