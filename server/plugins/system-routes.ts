import type { FastifyInstance } from 'fastify';
import { generalAccess } from '../middlewares/generalAccess.js';
import { publicAccess } from '../middlewares/publicAccess.js';
import { errors } from '../framework/http/error-schema.js';

export function registerSystemRoutes(
  server: FastifyInstance,
  checkDatabase: () => Promise<void>,
): void {
  server.get('/api/health', { preHandler: publicAccess, schema: { security: [], tags: ['System'], summary: 'Проверка API и БД' } }, async () => {
    await checkDatabase();
    return { status: 'ok', database: 'ok' };
  });

  server.get('/api/operator/status', {
    preHandler: generalAccess,
    schema: {
      tags: ['Access'], summary: 'Пример общего доступа: admin или manager',
      response: { 200: { type: 'object', properties: { access: { type: 'string' } } }, ...errors },
    },
    handler: async () => ({ access: 'operator' }),
  });
}
