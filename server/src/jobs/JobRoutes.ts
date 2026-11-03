import type { FastifyInstance } from 'fastify';
import { errors } from '../../framework/http/error-schema.js';
import { authenticatedAccess } from '../../middlewares/authenticatedAccess.js';
import { jobStatuses, userJobStatuses } from './JobService.js';
import type { JobService, UserJobStatus } from './JobService.js';
import { JobController } from './JobController.js';
import type { JobCreateBody, JobListQuerystring } from './JobController.js';

const nullableText = { type: ['string', 'null'] } as const;
const nullableDate = { type: ['string', 'null'], format: 'date-time' } as const;

const summaryProperties = {
  id: { type: 'string' }, url: { type: 'string' }, source: { type: 'string' }, externalId: nullableText,
  company: { type: 'string' }, title: { type: 'string' }, location: nullableText,
  score: { type: ['integer', 'null'] }, why: nullableText, redFlags: { type: 'array', items: { type: 'string' } },
  status: { type: 'string', enum: jobStatuses }, postedAt: nullableDate,
  foundAt: { type: 'string', format: 'date-time' }, updatedAt: { type: 'string', format: 'date-time' },
} as const;
const summaryRequired = Object.keys(summaryProperties);

const jobSummarySchema = { type: 'object', additionalProperties: false, required: summaryRequired, properties: summaryProperties } as const;
const jobSchema = {
  type: 'object', additionalProperties: false, required: [...summaryRequired, 'description'],
  properties: { ...summaryProperties, description: nullableText },
} as const;
const idParams = { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', minLength: 1, maxLength: 64 } } } as const;
const positiveInteger = (maxLength: number) => ({ type: 'string', pattern: '^[1-9][0-9]*$', maxLength }) as const;

export function registerJobRoutes(server: FastifyInstance, jobs: JobService): void {
  const controller = new JobController(jobs);
  const tags = ['Jobs'];

  server.get<{ Querystring: JobListQuerystring }>('/api/jobs', {
    preHandler: authenticatedAccess,
    schema: {
      tags, summary: 'Свои вакансии: фильтры, поиск, сортировка, страницы',
      querystring: {
        type: 'object', additionalProperties: false,
        properties: {
          page: positiveInteger(10), limit: positiveInteger(3),
          status: { type: 'string', enum: jobStatuses },
          source: { type: 'string', minLength: 1, maxLength: 40 },
          search: { type: 'string', minLength: 1, maxLength: 200 },
          sort: { type: 'string', enum: ['found', 'score'] },
        },
      },
      response: {
        200: {
          type: 'object', additionalProperties: false, required: ['items', 'total', 'page', 'limit'],
          properties: { items: { type: 'array', items: jobSummarySchema }, total: { type: 'integer' }, page: { type: 'integer' }, limit: { type: 'integer' } },
        }, ...errors,
      },
    },
  }, controller.list);

  server.get('/api/jobs/summary', {
    preHandler: authenticatedAccess,
    schema: {
      tags, summary: 'Количество своих вакансий по статусам',
      response: {
        200: {
          type: 'object', additionalProperties: false, required: ['total', 'counts'],
          properties: {
            total: { type: 'integer' },
            counts: { type: 'object', additionalProperties: false, required: [...jobStatuses], properties: Object.fromEntries(jobStatuses.map((status) => [status, { type: 'integer' }])) },
          },
        }, ...errors,
      },
    },
  }, controller.summary);

  server.get<{ Params: { id: string } }>('/api/jobs/:id', {
    preHandler: authenticatedAccess,
    schema: { tags, summary: 'Вакансия с описанием', params: idParams, response: { 200: jobSchema, ...errors } },
  }, controller.get);

  server.post<{ Body: JobCreateBody }>('/api/jobs', {
    preHandler: authenticatedAccess,
    schema: {
      tags, summary: 'Добавить вакансию вручную',
      body: {
        type: 'object', additionalProperties: false, required: ['url', 'title', 'company'],
        properties: {
          url: { type: 'string', minLength: 1, maxLength: 2048 },
          title: { type: 'string', minLength: 1, maxLength: 300 },
          company: { type: 'string', minLength: 1, maxLength: 200 },
          source: { type: 'string', minLength: 1, maxLength: 40 },
          location: { type: 'string', maxLength: 200 },
          description: { type: 'string', maxLength: 100_000 },
        },
      },
      response: { 201: jobSchema, ...errors },
    },
  }, controller.create);

  server.patch<{ Params: { id: string }; Body: { status: UserJobStatus } }>('/api/jobs/:id', {
    preHandler: authenticatedAccess,
    schema: {
      tags, summary: 'Своё решение по вакансии: в очередь, отклонить или пропустить',
      params: idParams,
      body: {
        type: 'object', additionalProperties: false, required: ['status'],
        properties: { status: { type: 'string', enum: userJobStatuses } },
      },
      response: { 200: jobSchema, ...errors },
    },
  }, controller.changeStatus);

  server.delete<{ Params: { id: string } }>('/api/jobs/:id', {
    preHandler: authenticatedAccess,
    schema: { tags, summary: 'Удалить вакансию', params: idParams, response: { 204: { type: 'null' }, ...errors } },
  }, controller.remove);
}
