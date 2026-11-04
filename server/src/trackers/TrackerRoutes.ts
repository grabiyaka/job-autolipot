import type { FastifyInstance } from 'fastify';
import { errors, errorSchema } from '../../framework/http/error-schema.js';
import { authenticatedAccess } from '../../middlewares/authenticatedAccess.js';
import { TrackerController } from './TrackerController.js';
import type { TrackerProfileQuerystring } from './TrackerController.js';
import type { TrackerService } from './TrackerService.js';

const date = { type: 'string', format: 'date-time' } as const;
const strings = { type: 'array', items: { type: 'string' } } as const;
// 502: JT refused the token or the request; 503: not configured, unreachable or rate limited.
const trackerErrors = { ...errors, 502: errorSchema, 503: errorSchema };

const statusSchema = {
  type: 'object', additionalProperties: false, required: ['configured', 'linked', 'profile', 'error'],
  properties: {
    configured: { type: 'boolean' },
    linked: { type: ['boolean', 'null'] },
    profile: {
      type: ['object', 'null'], additionalProperties: false, required: ['revision', 'fetchedAt'],
      properties: { revision: { type: 'integer' }, fetchedAt: date },
    },
    error: { type: ['string', 'null'] },
  },
} as const;

const profileProperties = { markdown: { type: 'string' }, revision: { type: 'integer' }, fetchedAt: date, fromCache: { type: 'boolean' } } as const;
const profileSchema = { type: 'object', additionalProperties: false, required: Object.keys(profileProperties), properties: profileProperties } as const;

const count = { type: 'integer' } as const;
const reportProperties = {
  created: count, duplicates: count, alreadyApplied: count,
  invalid: {
    type: 'array',
    items: { type: 'object', additionalProperties: false, required: ['jobId', 'errors'], properties: { jobId: { type: 'string' }, errors: strings } },
  },
  unevaluated: strings, remaining: count, error: { type: ['string', 'null'] },
} as const;
const reportSchema = { type: 'object', additionalProperties: false, required: Object.keys(reportProperties), properties: reportProperties } as const;

export function registerTrackerRoutes(server: FastifyInstance, trackers: TrackerService): void {
  const controller = new TrackerController(trackers);
  const tags = ['Job-Tracker'];

  server.get('/api/tracker/status', {
    preHandler: authenticatedAccess,
    schema: { tags, summary: 'Настроен ли Job-Tracker, привязан ли он к вам и какая копия профиля сохранена', response: { 200: statusSchema, ...trackerErrors } },
  }, controller.status);

  server.get<{ Querystring: TrackerProfileQuerystring }>('/api/tracker/profile', {
    preHandler: authenticatedAccess,
    schema: {
      tags, summary: 'Профиль кандидата из Job-Tracker; refresh=true сверяет копию с Job-Tracker',
      querystring: { type: 'object', additionalProperties: false, properties: { refresh: { type: 'string', enum: ['true', 'false'] } } },
      response: { 200: profileSchema, ...trackerErrors },
    },
  }, controller.profile);

  server.post('/api/tracker/push', {
    preHandler: authenticatedAccess,
    schema: { tags, summary: 'Отправить в Job-Tracker очередную пачку (до 50) отобранных вакансий', response: { 200: reportSchema, ...trackerErrors } },
  }, controller.push);
}
