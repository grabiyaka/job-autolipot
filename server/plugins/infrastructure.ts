import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Clock, Identifiers } from '../framework/core/runtime.js';
import { createPrismaClient } from './database.js';

export async function registerInfrastructure(server: FastifyInstance, databaseUrl: string) {
  const prisma = createPrismaClient(databaseUrl);
  server.addHook('onClose', async () => prisma.$disconnect());
  await prisma.$connect();

  const clock: Clock = { now: () => new Date() };
  const identifiers: Identifiers = { next: () => randomUUID() };
  const checkDatabase = async (): Promise<void> => { await prisma.$queryRaw`SELECT 1`; };

  return { prisma, clock, identifiers, checkDatabase };
}
