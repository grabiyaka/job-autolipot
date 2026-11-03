import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import type { FastifyInstance } from 'fastify';
import { PrismaClient } from '../generated/prisma/client.js';
import type { Clock, Identifiers } from '../framework/core/runtime.js';

export async function registerInfrastructure(server: FastifyInstance, databaseUrl: string) {
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  server.addHook('onClose', async () => prisma.$disconnect());
  await prisma.$connect();

  const clock: Clock = { now: () => new Date() };
  const identifiers: Identifiers = { next: () => randomUUID() };
  const checkDatabase = async (): Promise<void> => { await prisma.$queryRaw`SELECT 1`; };

  return { prisma, clock, identifiers, checkDatabase };
}
