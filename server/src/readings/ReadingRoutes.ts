import { recordedActorRoles } from '../../framework/core/actor.js';
import type { FastifyInstance } from 'fastify';
import type { ReadingApi } from './ReadingTypes.js';
import { ReadingController } from './ReadingController.js';
import { guestAccess } from '../../middlewares/guestAccess.js';
import { errors } from '../../framework/http/error-schema.js';

const integer = { type: 'integer' } as const;
const text = { type: 'string' } as const;
const flag = { type: 'boolean' } as const;

const calculationSchema = {
  $id: 'Calculation', type: 'object', additionalProperties: false,
  required: ['subscriberId', 'accountNumber', 'previousReadingHundredths', 'newReadingHundredths', 'consumptionHundredths', 'waterTariffKopeks', 'drainageTariffKopeks', 'effectiveTariffKopeks', 'hasWater', 'hasDrainage', 'chargeKopeks', 'balanceBeforeKopeks', 'balanceAfterKopeks', 'subscriberVersion', 'policyVersion'],
  properties: {
    subscriberId: text, accountNumber: text, previousReadingHundredths: integer,
    newReadingHundredths: integer, consumptionHundredths: integer,
    waterTariffKopeks: integer, drainageTariffKopeks: integer, effectiveTariffKopeks: integer,
    hasWater: flag, hasDrainage: flag, chargeKopeks: integer,
    balanceBeforeKopeks: integer, balanceAfterKopeks: integer,
    subscriberVersion: integer, policyVersion: text,
  },
} as const;

const readingBody = {
  type: 'object', additionalProperties: false, required: ['subscriberId', 'reading'],
  properties: {
    subscriberId: { type: 'string', minLength: 1, maxLength: 100, examples: ['demo-subscriber-1'] },
    reading: { type: 'string', pattern: '^\\d{1,7}([.,]\\d{1,6})?$', examples: ['1511.00'], description: 'Показание в м³. Округляется до сотых; точный исходный ввод сохраняется.' },
  },
} as const;

const submitBody = {
  ...readingBody,
  required: ['subscriberId', 'reading', 'expectedVersion'],
  properties: { ...readingBody.properties, expectedVersion: { type: 'integer', minimum: 0, examples: [0] } },
} as const;

const recordSchema = {
  $id: 'ReadingRecord', type: 'object', additionalProperties: false,
  required: ['id', 'idempotencyKey', 'originalInput', 'actor', 'source', 'createdAt', 'subscriberBefore', 'calculation'],
  properties: {
    id: text, idempotencyKey: text,
    // Evidence may come from a typed service call, so preserve its exact input
    // independently of the stricter HTTP form's syntax and length limits.
    originalInput: {
      type: 'object', additionalProperties: false, required: ['subscriberId', 'reading', 'expectedVersion'],
      properties: { subscriberId: text, reading: text, expectedVersion: integer },
    },
    actor: {
      type: 'object', required: ['id', 'role'], additionalProperties: false,
      properties: { id: text, role: { type: 'string', enum: recordedActorRoles }, subscriberId: text },
    },
    source: { type: 'string', enum: ['demo-api'] }, createdAt: { type: 'string', format: 'date-time' },
    subscriberBefore: { $ref: 'Subscriber#' }, calculation: { $ref: 'Calculation#' },
  },
} as const;

export function registerReadingRoutes(server: FastifyInstance, readings: ReadingApi): void {
  server.addSchema(calculationSchema);
  server.addSchema(recordSchema);
  const controller = new ReadingController(readings);
  const secured = { security: [{ bearerAuth: [] }] };

  server.post('/api/readings/preview', {
    preHandler: guestAccess,
    schema: { ...secured, tags: ['Readings'], summary: 'Предварительный расчёт без записи', body: readingBody, response: {
      200: { type: 'object', properties: { calculation: { $ref: 'Calculation#' } } }, ...errors,
    } },
    handler: controller.preview,
  });

  const submitResponse = { type: 'object', properties: { record: { $ref: 'ReadingRecord#' }, replayed: { type: 'boolean' } } };
  server.post('/api/readings', {
    preHandler: guestAccess,
    schema: {
      ...secured, tags: ['Readings'], summary: 'Сохранить показание и начисление атомарно', body: submitBody,
      headers: { type: 'object', required: ['idempotency-key'], properties: { 'idempotency-key': { type: 'string', minLength: 1, maxLength: 120 } } },
      response: { 200: submitResponse, 201: submitResponse, ...errors },
    },
    handler: controller.submit,
  });

  server.get('/api/subscribers/:subscriberId/readings', {
    preHandler: guestAccess,
    schema: {
      ...secured, tags: ['Readings'], summary: 'Неизменяемая история показаний и расчётов',
      params: { type: 'object', required: ['subscriberId'], properties: { subscriberId: { type: 'string', minLength: 1, maxLength: 100 } } },
      response: { 200: { type: 'object', properties: { readings: { type: 'array', items: { $ref: 'ReadingRecord#' } } } }, ...errors },
    },
    handler: controller.history,
  });
}
