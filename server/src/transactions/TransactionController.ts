import type { FastifyReply, FastifyRequest } from 'fastify';
import { requireActor } from '../../framework/core/actor.js';
import { ApplicationError } from '../../framework/core/errors.js';
import type {
  AmendTransactionInput, CancelTransactionInput, CreateTransactionInput,
  TransactionApi, TransactionListInput,
} from './TransactionTypes.js';

type ListQuery = Omit<TransactionListInput, 'page' | 'limit'> & Readonly<{ page?: string; limit?: string }>;
type TransactionParams = { id: string };

function listInput(query: ListQuery): TransactionListInput {
  const { page, limit, ...filters } = query;
  return {
    ...filters,
    ...(page === undefined ? {} : { page: Number(page) }),
    ...(limit === undefined ? {} : { limit: Number(limit) }),
  };
}

function idempotencyKey(request: FastifyRequest): string {
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string') {
    throw new ApplicationError('IDEMPOTENCY_KEY_REQUIRED', 'Нужен заголовок Idempotency-Key.', 400);
  }
  return key;
}

export class TransactionController {
  constructor(private readonly transactions: TransactionApi) {}

  list = async (request: FastifyRequest<{ Querystring: ListQuery }>) => (
    this.transactions.list(listInput(request.query), requireActor(request.actor))
  );

  getById = async (request: FastifyRequest<{ Params: TransactionParams }>) => ({
    transaction: await this.transactions.getById(request.params.id, requireActor(request.actor)),
  });

  preview = async (request: FastifyRequest<{ Body: CreateTransactionInput }>) => ({
    effect: await this.transactions.preview(request.body, requireActor(request.actor)),
  });

  create = async (request: FastifyRequest<{ Body: CreateTransactionInput }>, reply: FastifyReply) => {
    const result = await this.transactions.create(request.body, requireActor(request.actor), idempotencyKey(request));
    return reply.code(result.replayed ? 200 : 201).send(result);
  };

  cancel = async (request: FastifyRequest<{ Params: TransactionParams; Body: CancelTransactionInput }>, reply: FastifyReply) => {
    const result = await this.transactions.cancel(request.params.id, request.body, requireActor(request.actor), idempotencyKey(request));
    return reply.code(result.replayed ? 200 : 201).send(result);
  };

  amendDescription = async (request: FastifyRequest<{ Params: TransactionParams; Body: AmendTransactionInput }>, reply: FastifyReply) => {
    const result = await this.transactions.amendDescription(request.params.id, request.body, requireActor(request.actor), idempotencyKey(request));
    return reply.code(result.replayed ? 200 : 201).send(result);
  };

  exportCsv = async (request: FastifyRequest<{ Querystring: ListQuery }>, reply: FastifyReply) => {
    const csv = await this.transactions.exportCsv(listInput(request.query), requireActor(request.actor));
    return reply.type('text/csv; charset=utf-8')
      .header('Content-Disposition', 'attachment; filename="transactions.csv"')
      .send(csv);
  };
}
