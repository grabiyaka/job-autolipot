import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '../generated/prisma/client.js';
import { ScryptPasswords } from '../plugins/passwords.js';

// This key and password exist only in the opt-in disposable database test suite.
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

export async function createAuthFixture(server: FastifyInstance, database: PrismaClient) {
  const prefix = `auth-fixture-${randomUUID()}`;
  const subscriberAccount = await database.subscriber.create({
    data: {
      id: prefix, accountNumber: prefix, meterNumber: prefix,
      displayName: 'Isolated authentication test account', villageName: 'Synthetic test village',
      readingHundredths: 0, balanceKopeks: 0, waterTariffKopeks: 1_000, drainageTariffKopeks: 0,
      hasWater: true, hasDrainage: false,
    },
  });
  const passwordHash = await new ScryptPasswords().hash(testPassword);
  const admin = await database.user.create({
    data: { email: `${prefix}-admin@example.test`, name: 'Test admin', passwordHash, role: 'admin' },
  });
  const manager = await database.user.create({
    data: { email: `${prefix}-manager@example.test`, name: 'Test manager', passwordHash, role: 'manager' },
  });
  const guest = await database.user.create({
    data: {
      email: `${prefix}-guest@example.test`, name: 'Test guest', passwordHash,
      role: 'guest', subscriberId: subscriberAccount.id,
    },
  });
  const foreign = await database.user.create({
    data: { email: `${prefix}-foreign@example.test`, name: 'Test foreign', passwordHash, role: 'foreign' },
  });
  const managerHeaders = await loginTestUser(server, manager.email);
  const guestHeaders = await loginTestUser(server, guest.email);
  const userIds = [admin.id, manager.id, guest.id, foreign.id];
  return {
    admin,
    manager,
    guest,
    foreign,
    // Existing subject-domain tests describe business personas, not framework roles.
    operator: manager,
    subscriber: guest,
    subscriberAccount,
    adminHeaders: await loginTestUser(server, admin.email),
    managerHeaders,
    guestHeaders,
    foreignHeaders: await loginTestUser(server, foreign.email),
    operatorHeaders: managerHeaders,
    subscriberHeaders: guestHeaders,
    async dispose() {
      await database.authSession.deleteMany({ where: { userId: { in: userIds } } });
      await database.user.deleteMany({ where: { id: { in: userIds } } });
      await database.subscriber.delete({ where: { id: subscriberAccount.id } });
    },
  };
}
