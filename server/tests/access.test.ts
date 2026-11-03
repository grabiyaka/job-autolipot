import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Actor } from '../framework/core/actor.js';
import { ApplicationError } from '../framework/core/errors.js';
import { isUserRole, requireRole, userRoles } from '../framework/core/roles.js';
import type { UserRole } from '../framework/core/roles.js';
import { adminAccess } from '../middlewares/adminAccess.js';
import { authenticatedAccess } from '../middlewares/authenticatedAccess.js';
import { publicAccess } from '../middlewares/publicAccess.js';
import { registerRequestIdentity } from '../middlewares/requestIdentity.js';
import { rolesAccess } from '../middlewares/rolesAccess.js';

const policies = [
  { name: 'publicAccess', middleware: publicAccess, allowed: ['anonymous', ...userRoles] },
  { name: 'authenticatedAccess', middleware: authenticatedAccess, allowed: [...userRoles] },
  { name: 'adminAccess', middleware: adminAccess, allowed: ['admin'] },
  { name: 'rolesAccess', middleware: rolesAccess('user'), allowed: ['user'] },
];

describe('Composable route access middleware', () => {
  const server = Fastify();

  beforeAll(async () => {
    registerRequestIdentity(server);
    server.setErrorHandler((error, _request, reply) => {
      if (error instanceof ApplicationError) {
        return reply.code(error.statusCode).send({ code: error.code });
      }
      return reply.code(500).send({ code: 'UNEXPECTED_ERROR' });
    });
    // Only this isolated middleware test instance supplies actors without JWT authentication.
    server.addHook('onRequest', async request => {
      const role = request.headers['test-actor-role'];
      if (isUserRole(role)) request.actor = { id: `test-${role}`, role };
    });
    for (const policy of policies) {
      server.get(`/${policy.name}`, { preHandler: policy.middleware }, async () => ({ allowed: true }));
    }
    server.get('/combined', { preHandler: [authenticatedAccess, rolesAccess('user')] }, async () => ({ allowed: true }));
    await server.ready();
  });

  afterAll(async () => { await server.close(); });

  for (const policy of policies) {
    it.each(['anonymous', ...userRoles])(`${policy.name} handles %s explicitly`, async role => {
      const response = await server.inject({
        method: 'GET', url: `/${policy.name}`,
        headers: role === 'anonymous' ? {} : { 'test-actor-role': role },
      });
      const allowed = policy.allowed.includes(role);
      expect(response.statusCode, response.body).toBe(allowed ? 200 : role === 'anonymous' ? 401 : 403);
      if (!allowed) expect(response.json()).toEqual({ code: role === 'anonymous' ? 'UNAUTHENTICATED' : 'ACCESS_DENIED' });
    });
  }

  it('supports Fastify preHandler arrays and grants only explicitly listed roles', async () => {
    for (const role of ['anonymous', ...userRoles]) {
      const response = await server.inject({ method: 'GET', url: '/combined', headers: { 'test-actor-role': role } });
      expect(response.statusCode, response.body).toBe(role === 'user' ? 200 : role === 'anonymous' ? 401 : 403);
    }
  });

  it('rejects empty or misspelled role policies at registration time', () => {
    // @ts-expect-error A policy must name at least one role.
    expect(() => rolesAccess()).toThrow(/at least one known role/);
    // @ts-expect-error Unknown names are rejected by TypeScript and runtime validation.
    expect(() => rolesAccess('administrator')).toThrow(/at least one known role/);
  });

  it('does not recognize removed or misspelled role names', () => {
    for (const value of ['manager', 'guest', 'foreign', 'ADMIN', '', null, undefined, 1]) {
      expect(isUserRole(value)).toBe(false);
    }
  });
});

describe('Framework-independent role policy', () => {
  it('returns an authorized actor for use by application services', () => {
    const actor: Actor = { id: 'user-account', role: 'user' };
    expect(requireRole(actor, 'admin', 'user')).toBe(actor);
  });

  it.each(userRoles)('requires explicit inclusion of %s without implicit admin bypass', (role: UserRole) => {
    const actor: Actor = { id: 'account', role };
    if (role === 'user') expect(requireRole(actor, 'user')).toBe(actor);
    else expect(() => requireRole(actor, 'user')).toThrow(expect.objectContaining({ statusCode: 403 }));
  });

  it('distinguishes a missing identity from insufficient privileges', () => {
    expect(() => requireRole(null, 'admin')).toThrow(expect.objectContaining({ statusCode: 401 }));
    expect(() => requireRole({ id: 'account', role: 'user' }, 'admin')).toThrow(expect.objectContaining({ statusCode: 403 }));
  });
});
