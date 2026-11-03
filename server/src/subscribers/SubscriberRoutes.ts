import type { FastifyInstance } from 'fastify';
import type { SubscriberApi } from './SubscriberTypes.js';
import { SubscriberController } from './SubscriberController.js';
import { guestAccess } from '../../middlewares/guestAccess.js';
import { errors } from '../../framework/http/error-schema.js';

const integer = { type: 'integer' } as const;
const text = { type: 'string' } as const;
const flag = { type: 'boolean' } as const;

const subscriberSchema = {
  $id: 'Subscriber', type: 'object', additionalProperties: false,
  required: ['id', 'accountNumber', 'displayName', 'villageName', 'meterNumber', 'readingHundredths', 'balanceKopeks', 'maintenanceBalanceKopeks', 'verifiedReadingHundredths', 'verifiedAt', 'verifiedByTransactionId', 'waterTariffKopeks', 'drainageTariffKopeks', 'hasWater', 'hasDrainage', 'version'],
  properties: {
    id: text, accountNumber: text, displayName: text, villageName: text, meterNumber: text,
    readingHundredths: integer, balanceKopeks: integer, waterTariffKopeks: integer,
    maintenanceBalanceKopeks: integer,
    verifiedReadingHundredths: { type: ['integer', 'null'] },
    verifiedAt: { type: ['string', 'null'], format: 'date-time' },
    verifiedByTransactionId: { type: ['string', 'null'] },
    drainageTariffKopeks: integer, hasWater: flag, hasDrainage: flag, version: integer,
  },
} as const;

export function registerSubscriberRoutes(server: FastifyInstance, subscribers: SubscriberApi): void {
  server.addSchema(subscriberSchema);
  const controller = new SubscriberController(subscribers);

  server.get('/api/subscribers', {
    preHandler: guestAccess,
    schema: {
      security: [{ bearerAuth: [] }], tags: ['Subscribers'], summary: 'Доступные текущему пользователю абоненты',
      response: {
        200: { type: 'object', properties: { subscribers: { type: 'array', items: { $ref: 'Subscriber#' } } } },
        ...errors,
      },
    },
    handler: controller.list,
  });
}
