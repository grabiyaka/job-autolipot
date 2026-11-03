import type { FastifyInstance } from 'fastify';
import { publicAccess } from '../middlewares/publicAccess.js';

export function registerSystemRoutes(
  server: FastifyInstance,
  checkDatabase: () => Promise<void>,
): void {
  server.get('/api/health', { preHandler: publicAccess, schema: { security: [], tags: ['System'], summary: 'Проверка API и БД' } }, async () => {
    await checkDatabase();
    return { status: 'ok', database: 'ok' };
  });
}
