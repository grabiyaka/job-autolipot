import type { FastifyInstance } from 'fastify';
import { errors, errorSchema } from '../../framework/http/error-schema.js';
import { authenticatedAccess } from '../../middlewares/authenticatedAccess.js';
import { ApplicationController } from './ApplicationController.js';
import { applicationKinds, applicationStatuses, questionStatuses } from './ApplicationService.js';
import type { AnswerInput, ApplicationService } from './ApplicationService.js';

const date = { type: 'string', format: 'date-time' } as const;
const nullableDate = { type: ['string', 'null'], format: 'date-time' } as const;
const nullableText = { type: ['string', 'null'] } as const;
const count = { type: 'integer' } as const;
// 502/503: Job-Tracker refused or is down, the agent or the CV is not configured, the browser is busy.
const applyErrors = { ...errors, 502: errorSchema, 503: errorSchema };

const filledSchema = {
  type: 'array',
  items: { type: 'object', additionalProperties: false, required: ['field', 'value'], properties: { field: { type: 'string' }, value: { type: 'string' } } },
} as const;

const applicationProperties = {
  id: { type: 'string' }, jobId: { type: 'string' }, jobTitle: { type: 'string' }, company: { type: 'string' }, url: { type: 'string' },
  status: { type: 'string', enum: applicationStatuses }, kind: { type: 'string', enum: applicationKinds }, applyUrl: nullableText,
  filled: filledSchema, summary: nullableText, note: nullableText,
  inputTokens: count, cacheReadTokens: count, outputTokens: count, costMicros: count, startedAt: date, finishedAt: nullableDate,
} as const;
const applicationSchema = { type: 'object', additionalProperties: false, required: Object.keys(applicationProperties), properties: applicationProperties } as const;

const questionProperties = {
  id: { type: 'string' }, applicationId: { type: 'string' }, jobId: { type: 'string' }, jobTitle: { type: 'string' }, company: { type: 'string' },
  text: { type: 'string' }, answer: nullableText, status: { type: 'string', enum: questionStatuses }, telegramMessageId: nullableText,
  createdAt: date, answeredAt: nullableDate,
} as const;
const questionSchema = { type: 'object', additionalProperties: false, required: Object.keys(questionProperties), properties: questionProperties } as const;

const detailsSchema = {
  type: 'object', additionalProperties: false, required: [...Object.keys(applicationProperties), 'questions'],
  properties: { ...applicationProperties, questions: { type: 'array', items: questionSchema } },
} as const;

const submitSchema = {
  type: 'object', additionalProperties: false, required: ['application', 'tracker', 'message'],
  properties: {
    application: applicationSchema,
    tracker: { type: ['string', 'null'], enum: ['marked', 'already_applied', 'not_in_to_apply', 'conflict', 'unavailable', 'not_linked', null] },
    message: { type: 'string' },
  },
} as const;

const answerReportSchema = {
  type: 'object', additionalProperties: false, required: ['question', 'remaining', 'requeued'],
  properties: { question: questionSchema, remaining: count, requeued: { type: 'boolean' } },
} as const;

const idParams = { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', minLength: 1, maxLength: 64 } } } as const;

export function registerApplicationRoutes(server: FastifyInstance, applications: ApplicationService): void {
  const controller = new ApplicationController(applications);
  const tags = ['Applications'];

  server.get('/api/applications', {
    preHandler: authenticatedAccess,
    schema: { tags, summary: 'Свои попытки подачи, новые первыми', response: { 200: { type: 'array', items: applicationSchema }, ...errors } },
  }, controller.list);

  server.get<{ Params: { id: string } }>('/api/applications/:id', {
    preHandler: authenticatedAccess,
    schema: { tags, summary: 'Попытка подачи с заполненными полями и вопросами агента', params: idParams, response: { 200: detailsSchema, ...errors } },
  }, controller.get);

  server.post<{ Params: { id: string } }>('/api/applications/:id/submit', {
    preHandler: authenticatedAccess,
    schema: {
      tags, summary: 'Отправить заполненную попытку (ready) и отметить подачу в Job-Tracker; работает в процессе с настроенным агентом',
      params: idParams, response: { 200: submitSchema, ...applyErrors },
    },
  }, controller.submit);

  server.post<{ Params: { id: string } }>('/api/applications/:id/manual-applied', {
    preHandler: authenticatedAccess,
    schema: {
      tags, summary: '«Подал сам»: попытка manual → вакансия applied, отметка в Job-Tracker (channel company_site_manual)',
      params: idParams, response: { 200: submitSchema, ...applyErrors },
    },
  }, controller.manualApplied);

  server.post<{ Params: { id: string }; Body: AnswerInput }>('/api/questions/:id/answer', {
    preHandler: authenticatedAccess,
    schema: {
      tags, summary: 'Ответить на вопрос агента: ответ идёт в банк, после последнего ответа вакансия снова в очереди',
      params: idParams,
      body: { type: 'object', additionalProperties: false, required: ['answer'], properties: { answer: { type: 'string', minLength: 1, maxLength: 4000 } } },
      response: { 200: answerReportSchema, ...errors },
    },
  }, controller.answer);
}
