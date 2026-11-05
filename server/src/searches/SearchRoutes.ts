import type { FastifyInstance } from 'fastify';
import { errors } from '../../framework/http/error-schema.js';
import { authenticatedAccess } from '../../middlewares/authenticatedAccess.js';
import { searchStopReasons } from './SearchService.js';
import type { SearchChange, SearchInput, SearchService } from './SearchService.js';
import { SearchController } from './SearchController.js';
import type { SearchRunsQuerystring } from './SearchController.js';

const nullableText = { type: ['string', 'null'] } as const;
const date = { type: 'string', format: 'date-time' } as const;
const keywords = { type: 'string', minLength: 1, maxLength: 200 } as const;
const location = { type: ['string', 'null'], maxLength: 200 } as const;
const titleWords = { type: 'array', maxItems: 50, items: { type: 'string', minLength: 1, maxLength: 60 } } as const;

const searchProperties = {
  id: { type: 'string' }, source: { type: 'string' }, keywords: { type: 'string' }, location: nullableText,
  includeTitle: { type: 'array', items: { type: 'string' } }, excludeTitle: { type: 'array', items: { type: 'string' } },
  easyApplyOnly: { type: 'boolean' }, enabled: { type: 'boolean' }, createdAt: date, updatedAt: date,
} as const;
const searchSchema = {
  type: 'object', additionalProperties: false, required: Object.keys(searchProperties), properties: searchProperties,
} as const;

const count = { type: 'integer' } as const;
const runProperties = {
  id: { type: 'string' }, pages: count, seen: count, fresh: count, filtered: count, created: count, duplicates: count, invalid: count,
  stopped: { type: 'string', enum: searchStopReasons }, error: nullableText, startedAt: date, finishedAt: date,
} as const;
const runSchema = { type: 'object', additionalProperties: false, required: Object.keys(runProperties), properties: runProperties } as const;

const idParams = { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', minLength: 1, maxLength: 64 } } } as const;

export function registerSearchRoutes(server: FastifyInstance, searches: SearchService): void {
  const controller = new SearchController(searches);
  const tags = ['Searches'];

  server.get('/api/searches/sources', {
    preHandler: authenticatedAccess,
    schema: {
      tags, summary: 'Подключённые источники вакансий',
      response: {
        200: {
          type: 'array',
          items: { type: 'object', additionalProperties: false, required: ['id', 'title'], properties: { id: { type: 'string' }, title: { type: 'string' } } },
        }, ...errors,
      },
    },
  }, controller.sources);

  server.get('/api/searches', {
    preHandler: authenticatedAccess,
    schema: { tags, summary: 'Свои сохранённые поиски', response: { 200: { type: 'array', items: searchSchema }, ...errors } },
  }, controller.list);

  server.post<{ Body: SearchInput }>('/api/searches', {
    preHandler: authenticatedAccess,
    schema: {
      tags, summary: 'Сохранить поиск: сборщик будет прогонять его по расписанию',
      body: {
        type: 'object', additionalProperties: false, required: ['source', 'keywords'],
        properties: {
          source: { type: 'string', minLength: 1, maxLength: 40 }, keywords, location,
          includeTitle: titleWords, excludeTitle: titleWords, easyApplyOnly: { type: 'boolean' }, enabled: { type: 'boolean' },
        },
      },
      response: { 201: searchSchema, ...errors },
    },
  }, controller.create);

  server.patch<{ Params: { id: string }; Body: SearchChange }>('/api/searches/:id', {
    preHandler: authenticatedAccess,
    schema: {
      tags, summary: 'Изменить поиск или выключить его',
      params: idParams,
      body: {
        type: 'object', additionalProperties: false, minProperties: 1,
        properties: {
          keywords, location, includeTitle: titleWords, excludeTitle: titleWords, easyApplyOnly: { type: 'boolean' }, enabled: { type: 'boolean' },
        },
      },
      response: { 200: searchSchema, ...errors },
    },
  }, controller.update);

  server.delete<{ Params: { id: string } }>('/api/searches/:id', {
    preHandler: authenticatedAccess,
    schema: { tags, summary: 'Удалить поиск и историю его прогонов', params: idParams, response: { 204: { type: 'null' }, ...errors } },
  }, controller.remove);

  server.get<{ Params: { id: string }; Querystring: SearchRunsQuerystring }>('/api/searches/:id/runs', {
    preHandler: authenticatedAccess,
    schema: {
      tags, summary: 'Последние прогоны поиска, новые сначала',
      params: idParams,
      querystring: {
        type: 'object', additionalProperties: false,
        properties: { limit: { type: 'string', pattern: '^[1-9][0-9]*$', maxLength: 3 } },
      },
      response: { 200: { type: 'array', items: runSchema }, ...errors },
    },
  }, controller.runs);
}
