import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { PrismaClient } from '../generated/prisma/client.js';

/** DATABASE_URL uses the Prisma SQLite form `file:<path>`; relative paths resolve from server/. */
export function createPrismaClient(databaseUrl: string): PrismaClient {
  return new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: databaseUrl }) });
}
