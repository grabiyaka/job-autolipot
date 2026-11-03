import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '../generated/prisma/client.js';
import { ScryptPasswords } from '../plugins/passwords.js';

// This key and password exist only in the disposable test database suite.
export const testAuth = {
  secret: 'isolated-integration-tests-only-secret-2026',
  origin: 'http://localhost:3400',
  cookieSecure: false,
};
export const testPassword = 'Integration-test-password-2026!';
export const mutationHeaders = {
  origin: testAuth.origin,
  'x-requested-with': 'XMLHttpRequest',
};
export type AuthHeaders = typeof mutationHeaders & { cookie: string };

export async function loginTestUser(server: FastifyInstance, email: string): Promise<AuthHeaders> {
  const response = await server.inject({
    method: 'POST', url: '/api/auth/login', headers: mutationHeaders,
    payload: { email, password: testPassword },
  });
  if (response.statusCode !== 200) throw new Error(`Fixture login failed: ${response.statusCode} ${response.body}`);
  const cookie = response.cookies.find(candidate => candidate.name === 'framework_session');
  if (!cookie) throw new Error('Fixture login did not issue the session cookie.');
  return { ...mutationHeaders, cookie: `${cookie.name}=${cookie.value}` };
}

/** A migrated SQLite file in a temporary directory; never touches DATABASE_URL. */
export function createTestDatabase(): { url: string; dispose(): void } {
  const directory = mkdtempSync(path.join(tmpdir(), 'job-autopilot-test-'));
  const url = `file:${path.join(directory, 'test.db')}`;
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], { env: { ...process.env, DATABASE_URL: url }, stdio: 'ignore' });
  return { url, dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

export async function createAuthFixture(server: FastifyInstance, database: PrismaClient) {
  const prefix = `auth-fixture-${randomUUID()}`;
  const passwordHash = await new ScryptPasswords().hash(testPassword);
  const admin = await database.user.create({
    data: { email: `${prefix}-admin@example.test`, name: 'Test admin', passwordHash, role: 'admin' },
  });
  const user = await database.user.create({
    data: { email: `${prefix}-user@example.test`, name: 'Test user', passwordHash, role: 'user' },
  });
  const userIds = [admin.id, user.id];
  return {
    admin,
    user,
    adminHeaders: await loginTestUser(server, admin.email),
    userHeaders: await loginTestUser(server, user.email),
    async dispose() {
      await database.authSession.deleteMany({ where: { userId: { in: userIds } } });
      await database.user.deleteMany({ where: { id: { in: userIds } } });
    },
  };
}
