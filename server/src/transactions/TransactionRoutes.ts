import type { FastifyInstance } from 'fastify';
import { guestAccess } from '../../middlewares/guestAccess.js';
import { generalAccess } from '../../middlewares/generalAccess.js';
import { recordedActorRoles } from '../../framework/core/actor.js';
import { errors } from '../../framework/http/error-schema.js';
import { TransactionController } from './TransactionController.js';
import type { TransactionApi } from './TransactionTypes.js';

const integer = { type: 'integer' } as const;
const text = { type: 'string' } as const;
const flag = { type: 'boolean' } as const;
const identifier = { type: 'string', minLength: 1, maxLength: 100 } as const;
const timestamp = { type: 'string', format: 'date-time' } as const;
const nullableText = { anyOf: [text, { type: 'null' }] } as const;
const nullableVerification = { anyOf: [{ $ref: 'TransactionVerification#' }, { type: 'null' }] } as const;
const expectedVersion = { type: 'integer', minimum: 0, maximum: 2_147_483_647 } as const;
const description = { type: 'string', minLength: 1, maxLength: 2_000, pattern: '\\S' } as const;
const reason = { type: 'string', minLength: 1, maxLength: 2_000, pattern: '\\S' } as const;
const reading = {
  type: 'string', minLength: 1, maxLength: 14, pattern: '^\\d{1,7}([.,]\\d{1,6})?$',
  description: 'Показание в м³. Точный десятичный ввод округляется до сотых.', examples: ['1511.00'],
} as const;
const amount = {
  type: 'string', minLength: 1, maxLength: 15, pattern: '^\\d{1,8}([.,]\\d{1,6})?$',
  description: 'Сумма в гривнах строкой; расчёты и ответы — в целых копейках.', examples: ['250.00'],
} as const;
const balance = { ...amount, maxLength: 16, pattern: '^-?\\d{1,8}([.,]\\d{1,6})?$', examples: ['-50.00'] } as const;
const transactionKind = {
  type: 'string', enum: [
    'payment', 'meter-reading', 'meter-reconciliation', 'recalculation', 'note',
    'cancellation', 'description-change', 'origin', 'maintenance-fee', 'maintenance-transfer',
    'maintenance-fee-reversal', 'maintenance-transfer-reversal', 'meter-replacement-closing', 'meter-replacement-reset',
  ],
} as const;

const createInputSchema = {
  $id: 'TransactionCreateInput',
  oneOf: [
    {
      type: 'object', additionalProperties: false,
      required: ['kind', 'subscriberId', 'expectedVersion', 'amount', 'method'],
      properties: {
        kind: { type: 'string', enum: ['payment'] }, subscriberId: identifier, expectedVersion, amount,
        method: { type: 'string', enum: ['cash', 'bank'] },
        externalReference: { type: 'string', minLength: 1, maxLength: 200, pattern: '\\S' },
        purpose: { type: 'string', minLength: 1, maxLength: 1_000, pattern: '\\S' },
      },
      anyOf: [
        { type: 'object', properties: { method: { type: 'string', enum: ['cash'] } } },
        { type: 'object', properties: { method: { type: 'string', enum: ['bank'] } }, required: ['externalReference'] },
      ],
    },
    {
      type: 'object', additionalProperties: false, required: ['kind', 'subscriberId', 'expectedVersion', 'reading'],
      properties: {
        kind: { type: 'string', enum: ['reading'] }, subscriberId: identifier, expectedVersion, reading,
        verified: { type: 'boolean', description: 'Контрольное показание подтверждает администратор или менеджер.' },
      },
    },
    {
      type: 'object', additionalProperties: false,
      required: ['kind', 'subscriberId', 'expectedVersion', 'reading', 'balance', 'maintenanceBalance', 'reason'],
      properties: {
        kind: { type: 'string', enum: ['reconciliation'] }, subscriberId: identifier, expectedVersion,
        reading, balance, maintenanceBalance: balance, reason,
      },
    },
    {
      type: 'object', additionalProperties: false, required: ['kind', 'subscriberId', 'expectedVersion', 'description'],
      properties: { kind: { type: 'string', enum: ['note'] }, subscriberId: identifier, expectedVersion, description },
    },
  ],
} as const;

const cancelInputSchema = {
  $id: 'TransactionCancelInput', type: 'object', additionalProperties: false,
  required: ['expectedVersion', 'reason'], properties: { expectedVersion, reason },
} as const;
const amendInputSchema = {
  $id: 'TransactionAmendInput', type: 'object', additionalProperties: false,
  required: ['expectedVersion', 'description', 'reason'], properties: { expectedVersion, description, reason },
} as const;

// Stored evidence may originate in another domain, outside this HTTP adapter's input restrictions.
const submissionEvidence = { subscriberId: text, expectedVersion: integer } as const;
const createEvidenceSchema = {
  $id: 'TransactionCreateEvidence',
  oneOf: [
    {
      type: 'object', additionalProperties: false,
      required: ['kind', 'subscriberId', 'expectedVersion', 'amount', 'method'],
      properties: {
        ...submissionEvidence, kind: { type: 'string', enum: ['payment'] }, amount: text,
        method: { type: 'string', enum: ['cash', 'bank'] }, externalReference: text, purpose: text,
      },
    },
    {
      type: 'object', additionalProperties: false, required: ['kind', 'subscriberId', 'expectedVersion', 'reading'],
      properties: { ...submissionEvidence, kind: { type: 'string', enum: ['reading'] }, reading: text, verified: flag },
    },
    {
      type: 'object', additionalProperties: false,
      required: ['kind', 'subscriberId', 'expectedVersion', 'reading', 'balance', 'maintenanceBalance', 'reason'],
      properties: {
        ...submissionEvidence, kind: { type: 'string', enum: ['reconciliation'] },
        reading: text, balance: text, maintenanceBalance: text, reason: text,
      },
    },
    {
      type: 'object', additionalProperties: false, required: ['kind', 'subscriberId', 'expectedVersion', 'description'],
      properties: { ...submissionEvidence, kind: { type: 'string', enum: ['note'] }, description: text },
    },
  ],
} as const;
const cancelEvidenceSchema = {
  $id: 'TransactionCancelEvidence', type: 'object', additionalProperties: false,
  required: ['expectedVersion', 'reason'], properties: { expectedVersion: integer, reason: text },
} as const;
const amendEvidenceSchema = {
  $id: 'TransactionAmendEvidence', type: 'object', additionalProperties: false,
  required: ['expectedVersion', 'description', 'reason'],
  properties: { expectedVersion: integer, description: text, reason: text },
} as const;

const stateSchema = {
  $id: 'TransactionState', type: 'object', additionalProperties: false,
  required: ['balanceKopeks', 'maintenanceBalanceKopeks', 'readingHundredths'],
  properties: { balanceKopeks: integer, maintenanceBalanceKopeks: integer, readingHundredths: integer },
} as const;
const tariffSchema = {
  $id: 'TransactionTariff', type: 'object', additionalProperties: false,
  required: ['waterKopeks', 'drainageKopeks', 'effectiveKopeks', 'hasWater', 'hasDrainage'],
  properties: { waterKopeks: integer, drainageKopeks: integer, effectiveKopeks: integer, hasWater: flag, hasDrainage: flag },
} as const;
const paymentSchema = {
  $id: 'TransactionPayment', type: 'object', additionalProperties: false,
  required: ['amountKopeks', 'waterKopeks', 'maintenanceKopeks', 'method', 'externalReference', 'purpose'],
  properties: {
    amountKopeks: integer, waterKopeks: integer, maintenanceKopeks: integer,
    method: { type: 'string', enum: ['cash', 'bank'] }, externalReference: nullableText, purpose: nullableText,
  },
} as const;
const effectSchema = {
  $id: 'TransactionEffect', type: 'object', additionalProperties: false,
  required: ['kind', 'category', 'description', 'before', 'change', 'after', 'tariff', 'payment', 'confirmsReading', 'policyVersion'],
  properties: {
    kind: transactionKind, category: { type: 'string', enum: ['system', 'cash', 'bank', 'recalculation', 'note'] },
    description: text, before: { $ref: 'TransactionState#' }, change: { $ref: 'TransactionState#' },
    after: { $ref: 'TransactionState#' }, tariff: { $ref: 'TransactionTariff#' },
    payment: { anyOf: [{ $ref: 'TransactionPayment#' }, { type: 'null' }] },
    confirmsReading: flag, policyVersion: text,
  },
} as const;
const verificationSchema = {
  $id: 'TransactionVerification', type: 'object', additionalProperties: false,
  required: ['transactionId', 'readingHundredths', 'confirmedAt'],
  properties: { transactionId: text, readingHundredths: integer, confirmedAt: timestamp },
} as const;
const requestSchema = {
  $id: 'TransactionRequest',
  oneOf: [
    {
      type: 'object', additionalProperties: false, required: ['action', 'input'],
      properties: { action: { type: 'string', enum: ['create'] }, input: { $ref: 'TransactionCreateEvidence#' } },
    },
    {
      type: 'object', additionalProperties: false, required: ['action', 'transactionId', 'input'],
      properties: { action: { type: 'string', enum: ['cancel'] }, transactionId: text, input: { $ref: 'TransactionCancelEvidence#' } },
    },
    {
      type: 'object', additionalProperties: false, required: ['action', 'transactionId', 'input'],
      properties: { action: { type: 'string', enum: ['amend'] }, transactionId: text, input: { $ref: 'TransactionAmendEvidence#' } },
    },
    {
      type: 'object', additionalProperties: false, required: ['action', 'reading'],
      properties: { action: { type: 'string', enum: ['reading-demo'] }, reading: { $ref: 'ReadingRecord#' } },
    },
  ],
} as const;
const recordSchema = {
  $id: 'TransactionRecord', type: 'object', additionalProperties: false,
  required: [
    'id', 'sequence', 'idempotencyKey', 'subscriberId', 'accountNumber', 'actor', 'createdAt', 'effectiveAt',
    'request', 'subscriberBefore', 'effect', 'verificationBefore', 'verificationAfter', 'reversesId', 'amendsId',
  ],
  properties: {
    id: text, sequence: integer, idempotencyKey: text, subscriberId: text, accountNumber: text,
    actor: {
      type: 'object', additionalProperties: false, required: ['id', 'role'],
      properties: { id: text, role: { type: 'string', enum: recordedActorRoles }, subscriberId: text },
    },
    createdAt: timestamp, effectiveAt: timestamp, request: { $ref: 'TransactionRequest#' },
    subscriberBefore: { $ref: 'Subscriber#' }, effect: { $ref: 'TransactionEffect#' },
    verificationBefore: nullableVerification, verificationAfter: nullableVerification,
    reversesId: nullableText, amendsId: nullableText,
  },
} as const;
const viewSchema = {
  $id: 'TransactionView', type: 'object', additionalProperties: false,
  required: ['record', 'description', 'cancelledBy', 'projection'],
  properties: {
    record: { $ref: 'TransactionRecord#' }, description: text, cancelledBy: nullableText,
    projection: {
      type: 'object', additionalProperties: false, required: ['before', 'after'],
      properties: { before: { $ref: 'TransactionState#' }, after: { $ref: 'TransactionState#' } },
    },
  },
} as const;
const pageSchema = {
  $id: 'TransactionPage', type: 'object', additionalProperties: false, required: ['items', 'total', 'page', 'limit'],
  properties: { items: { type: 'array', items: { $ref: 'TransactionView#' } }, total: integer, page: integer, limit: integer },
} as const;
const resultSchema = {
  $id: 'TransactionResult', type: 'object', additionalProperties: false, required: ['record', 'replayed'],
  properties: { record: { $ref: 'TransactionRecord#' }, replayed: flag },
} as const;

const listQuery = {
  type: 'object', additionalProperties: false,
  properties: {
    subscriberId: identifier, kind: transactionKind,
    from: { anyOf: [{ type: 'string', format: 'date' }, timestamp], description: 'Дата или момент начала периода включительно.' },
    to: { anyOf: [{ type: 'string', format: 'date' }, timestamp], description: 'Дата или момент конца периода включительно. Дата включает весь день UTC.' },
    search: { type: 'string', minLength: 1, maxLength: 200 },
    page: { type: 'string', pattern: '^(0|[1-9]\\d{0,8})$', description: 'Номер страницы, начиная с 0; по умолчанию 0.' },
    limit: { type: 'string', pattern: '^([1-9]\\d?|1\\d{2}|200)$', description: 'Количество записей на странице, от 1 до 200; по умолчанию 50.' },
    order: { type: 'string', enum: ['asc', 'desc'] },
  },
} as const;
const params = { type: 'object', additionalProperties: false, required: ['id'], properties: { id: identifier } } as const;
const idempotencyHeaders = {
  type: 'object', required: ['idempotency-key'],
  properties: { 'idempotency-key': { type: 'string', minLength: 1, maxLength: 128, pattern: '\\S' } },
} as const;
const mutationResponses = { 200: { $ref: 'TransactionResult#' }, 201: { $ref: 'TransactionResult#' }, ...errors };

export function registerTransactionRoutes(server: FastifyInstance, transactions: TransactionApi): void {
  for (const schema of [
    createInputSchema, cancelInputSchema, amendInputSchema, createEvidenceSchema, cancelEvidenceSchema, amendEvidenceSchema,
    stateSchema, tariffSchema, paymentSchema,
    effectSchema, verificationSchema, requestSchema, recordSchema, viewSchema, pageSchema, resultSchema,
  ]) server.addSchema(schema);
  const controller = new TransactionController(transactions);
  const secured = { security: [{ bearerAuth: [] }], tags: ['Transactions'] };

  server.get('/api/transactions', {
    preHandler: guestAccess,
    schema: {
      ...secured, summary: 'История операций с фильтрами и пагинацией', querystring: listQuery,
      description: 'Гость видит операции связанного абонента; администратор и менеджер — операции всех абонентов.',
      response: { 200: { $ref: 'TransactionPage#' }, ...errors },
    },
    handler: controller.list,
  });

  server.get('/api/transactions/export.csv', {
    preHandler: generalAccess,
    schema: {
      ...secured, summary: 'Выгрузить отфильтрованную историю в CSV', querystring: listQuery,
      description: 'Доступно администратору и менеджеру. Выгружаются все подходящие операции независимо от страницы.',
      produces: ['text/csv'], response: { 200: { type: 'string' }, ...errors },
    },
    handler: controller.exportCsv,
  });

  server.get('/api/transactions/:id', {
    preHandler: guestAccess,
    schema: {
      ...secured, summary: 'Операция, её исходные данные и актуальное состояние', params,
      response: {
        200: { type: 'object', additionalProperties: false, required: ['transaction'], properties: { transaction: { $ref: 'TransactionView#' } } },
        ...errors,
      },
    },
    handler: controller.getById,
  });

  server.post('/api/transactions/preview', {
    preHandler: guestAccess,
    schema: {
      ...secured, summary: 'Рассчитать последствия операции без сохранения', body: { $ref: 'TransactionCreateInput#' },
      response: {
        200: { type: 'object', additionalProperties: false, required: ['effect'], properties: { effect: { $ref: 'TransactionEffect#' } } },
        ...errors,
      },
    },
    handler: controller.preview,
  });

  server.post('/api/transactions', {
    preHandler: guestAccess,
    schema: {
      ...secured, summary: 'Сохранить оплату, показание, сверку или заметку',
      description: 'Гость может передавать показания связанного абонента. Остальные операции выполняет администратор или менеджер. Повтор с тем же Idempotency-Key возвращает сохранённый результат.',
      body: { $ref: 'TransactionCreateInput#' }, headers: idempotencyHeaders, response: mutationResponses,
    },
    handler: controller.create,
  });

  server.post('/api/transactions/:id/cancel', {
    preHandler: generalAccess,
    schema: {
      ...secured, summary: 'Отменить операцию отдельной записью с сохранением истории', params,
      body: { $ref: 'TransactionCancelInput#' }, headers: idempotencyHeaders, response: mutationResponses,
    },
    handler: controller.cancel,
  });

  server.patch('/api/transactions/:id/description', {
    preHandler: generalAccess,
    schema: {
      ...secured, summary: 'Уточнить описание операции с записью причины изменения', params,
      body: { $ref: 'TransactionAmendInput#' }, headers: idempotencyHeaders, response: mutationResponses,
    },
    handler: controller.amendDescription,
  });
}
