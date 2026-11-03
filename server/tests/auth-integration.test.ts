import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../app.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { createPrismaClient } from '../plugins/database.js';
import {
  createAuthFixture, createTestDatabase, mutationHeaders, testAuth, testPassword,
} from './auth-fixture.js';

type Claims = { sub: string; sid: string; exp: number; iss: string; aud: string; iat?: number };

function tokenFromCookie(cookie: string): string {
  return cookie.substring(cookie.indexOf('=') + 1);
}

function claimsOf(token: string): Claims {
  return JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as Claims;
}

function signClaims(claims: object, secret = testAuth.secret, header: object = { alg: 'HS256', typ: 'JWT' }): string {
  const data = [header, claims].map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
  return `${data}.${createHmac('sha256', secret).update(data).digest('base64url')}`;
}

describe('JWT authentication: real SQLite users and sessions', () => {
  let testDatabase: ReturnType<typeof createTestDatabase>;
  let database: PrismaClient;
  let server: Awaited<ReturnType<typeof buildServer>>;
  let auth: Awaited<ReturnType<typeof createAuthFixture>>;
  let requestAddress = 1;

  beforeAll(async () => {
    testDatabase = createTestDatabase();
    database = createPrismaClient(testDatabase.url);
    await database.$connect();
    server = await buildServer({
      databaseUrl: testDatabase.url, logger: false,
      auth: { ...testAuth, cookieSecure: true, allowedOrigins: ['http://localhost:5173'] },
    });
    auth = await createAuthFixture(server, database);
  }, 60_000);

  afterAll(async () => {
    await server?.close();
    await auth?.dispose();
    await database?.$disconnect();
    testDatabase?.dispose();
  });

  function login(payload: object = { email: auth.user.email, password: testPassword }) {
    return server.inject({
      method: 'POST', url: '/api/auth/login', headers: mutationHeaders, payload,
      remoteAddress: `192.0.2.${requestAddress++}`,
    });
  }

  it('logs in, sets a restricted cookie, and restores a session without exposing secrets', async () => {
    const response = await login({ email: auth.user.email.toUpperCase(), password: testPassword });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      user: { id: auth.user.id, email: auth.user.email, name: auth.user.name, role: 'user' },
      expiresAt: expect.any(String),
    });
    const header = response.headers['set-cookie'];
    expect(header).toEqual(expect.stringContaining('HttpOnly'));
    expect(header).toEqual(expect.stringContaining('Secure'));
    expect(header).toEqual(expect.stringContaining('SameSite=Lax'));
    expect(header).toEqual(expect.stringContaining('Path=/api'));
    expect(header).not.toEqual(expect.stringContaining('Domain='));
    expect(response.body).not.toContain(testPassword);
    expect(response.body).not.toContain(auth.user.passwordHash);
    expect(response.json()).not.toHaveProperty('token');
    expect(response.json()).not.toHaveProperty('accessToken');
    const cookie = response.cookies.find(candidate => candidate.name === 'framework_session');
    expect(cookie).toBeDefined();
    const current = await server.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: `framework_session=${cookie!.value}` } });
    expect(current.statusCode, current.body).toBe(200);
    expect(current.json()).toEqual({ user: response.json<{ user: object }>().user });
  });

  it('accepts a signed bearer JWT for API clients and rejects the old demo tokens', async () => {
    const valid = await server.inject({
      method: 'GET', url: '/api/auth/me',
      headers: { authorization: `Bearer ${tokenFromCookie(auth.userHeaders.cookie)}` },
    });
    expect(valid.statusCode, valid.body).toBe(200);
    for (const token of ['demo-operator-token', 'demo-subscriber-token', 'not-a-jwt']) {
      const response = await server.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
      expect(response.statusCode, response.body).toBe(401);
    }
  });

  it('does not fall back from malformed authorization to a valid cookie or bypass cookie CSRF checks', async () => {
    for (const authorization of ['Basic Zm9vOmJhcg==', 'Bearer', 'Bearer invalid-jwt']) {
      const response = await server.inject({
        method: 'GET', url: '/api/auth/me',
        headers: { cookie: auth.userHeaders.cookie, authorization },
      });
      expect(response.statusCode, response.body).toBe(401);
    }
    const validBearer = `Bearer ${tokenFromCookie(auth.userHeaders.cookie)}`;
    for (const authorization of ['Basic Zm9vOmJhcg==', validBearer]) {
      const response = await server.inject({
        method: 'POST', url: '/api/auth/logout',
        headers: { cookie: auth.userHeaders.cookie, authorization, origin: testAuth.origin },
      });
      expect(response.statusCode, response.body).toBe(403);
    }
  });

  it('does not reveal whether an email exists or create sessions for invalid passwords', async () => {
    const before = await database.authSession.count({ where: { userId: auth.user.id } });
    const wrongPassword = await login({ email: auth.user.email, password: 'This-is-not-the-password!' });
    const missingUser = await login({ email: 'does-not-exist@example.test', password: 'This-is-not-the-password!' });
    expect(wrongPassword.statusCode).toBe(401);
    expect(missingUser.statusCode).toBe(401);
    const wrongPasswordError = wrongPassword.json<{ error: { code: string; message: string } }>().error;
    const missingUserError = missingUser.json<{ error: { code: string; message: string } }>().error;
    expect({ code: wrongPasswordError.code, message: wrongPasswordError.message })
      .toEqual({ code: missingUserError.code, message: missingUserError.message });
    expect(wrongPassword.cookies).toHaveLength(0);
    expect(await database.authSession.count({ where: { userId: auth.user.id } })).toBe(before);
  });

  it.each([
    {}, { email: 'invalid-email', password: testPassword },
    { email: 'test@example.test' }, { email: 'test@example.test', password: 123 },
    { email: 'test@example.test', password: testPassword, role: 'admin' },
  ])('rejects malformed login input before authentication: %j', async payload => {
    const response = await login(payload);
    expect(response.statusCode, response.body).toBe(400);
  });

  it('requires authentication for session and application routes', async () => {
    for (const url of ['/api/auth/me']) {
      const response = await server.inject({ method: 'GET', url });
      expect(response.statusCode, `${url}: ${response.body}`).toBe(401);
    }
    const oldCredentialsEndpoint = await server.inject({ method: 'GET', url: '/api/demo-info' });
    expect(oldCredentialsEndpoint.statusCode).toBe(404);
    expect(oldCredentialsEndpoint.body).not.toContain('demo-operator-token');
    expect((await server.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
  });

  it('rejects forged, expired, unbounded and incorrectly scoped JWTs', async () => {
    const claims = claimsOf(tokenFromCookie(auth.userHeaders.cookie));
    const { exp: _expiration, ...withoutExpiration } = claims;
    const tokens = [
      signClaims(claims, 'a-different-secret-used-to-forge-the-token'),
      signClaims({ ...claims, exp: Math.floor(Date.now() / 1_000) - 60 }),
      signClaims(withoutExpiration),
      signClaims({ ...claims, iss: 'another-server' }),
      signClaims({ ...claims, aud: 'another-client' }),
      signClaims({ ...claims, sub: auth.admin.id }),
      signClaims({ ...claims, sid: 'missing-session' }),
      signClaims(claims, testAuth.secret, { alg: 'none', typ: 'JWT' }),
    ];
    for (const token of tokens) {
      const response = await server.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: `framework_session=${token}` } });
      expect(response.statusCode, response.body).toBe(401);
    }
  });

  it('rejects a session expired in the database even while the JWT is valid', async () => {
    const loginResponse = await login();
    expect(loginResponse.statusCode, loginResponse.body).toBe(200);
    const token = loginResponse.cookies.find(cookie => cookie.name === 'framework_session')!.value;
    await database.authSession.update({
      where: { id: claimsOf(token).sid }, data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    const response = await server.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: `framework_session=${token}` } });
    expect(response.statusCode, response.body).toBe(401);
  });

  it('requires the same-origin request marker for cookie mutations and prevents login CSRF', async () => {
    const sessionsBefore = await database.authSession.count();
    for (const headers of [
      { cookie: auth.userHeaders.cookie },
      { cookie: auth.userHeaders.cookie, origin: testAuth.origin },
      { ...auth.userHeaders, origin: 'https://untrusted.example' },
      { ...auth.userHeaders, 'sec-fetch-site': 'cross-site' },
    ]) {
      const response = await server.inject({ method: 'POST', url: '/api/auth/logout', headers });
      expect(response.statusCode, response.body).toBe(403);
    }
    for (const headers of [{}, { origin: testAuth.origin }, { ...mutationHeaders, origin: 'https://untrusted.example' }]) {
      const response = await server.inject({
        method: 'POST', url: '/api/auth/login', headers,
        payload: { email: auth.user.email, password: testPassword },
        remoteAddress: `192.0.2.${requestAddress++}`,
      });
      expect(response.statusCode, response.body).toBe(403);
      expect(response.cookies).toHaveLength(0);
    }
    expect(await database.authSession.count()).toBe(sessionsBefore);
  });

  it('allows the explicitly configured Vite origin and does not enable wildcard CORS', async () => {
    const response = await server.inject({
      method: 'POST', url: '/api/auth/login',
      headers: { ...mutationHeaders, origin: 'http://localhost:5173' },
      payload: { email: auth.user.email, password: testPassword },
      remoteAddress: `192.0.2.${requestAddress++}`,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['access-control-allow-origin']).not.toBe('*');
  });

  it('keeps authentication-route CSRF protection for URL-encoded route spellings', async () => {
    for (const url of ['/api/auth/%6cogin', '/api/%61uth/login', '/api/auth/%6cogout']) {
      const response = await server.inject({
        method: 'POST', url, headers: { origin: testAuth.origin },
        ...(url.endsWith('ogin') ? { payload: { email: auth.user.email, password: testPassword } } : {}),
        remoteAddress: `192.0.2.${requestAddress++}`,
      });
      expect(response.statusCode, `${url}: ${response.body}`).toBe(403);
    }
    const allowed = await server.inject({
      method: 'POST', url: '/api/auth/%6cogin', headers: mutationHeaders,
      payload: { email: auth.user.email, password: testPassword },
      remoteAddress: `192.0.2.${requestAddress++}`,
    });
    expect(allowed.statusCode, allowed.body).toBe(200);
  });

  it('revokes a session on logout and invalidates a captured JWT immediately', async () => {
    const loginResponse = await login();
    expect(loginResponse.statusCode, loginResponse.body).toBe(200);
    const token = loginResponse.cookies.find(cookie => cookie.name === 'framework_session')!.value;
    const response = await server.inject({
      method: 'POST', url: '/api/auth/logout', headers: { ...mutationHeaders, cookie: `framework_session=${token}` },
    });
    expect(response.statusCode, response.body).toBe(204);
    expect(response.body).toBe('');
    expect(response.cookies.find(cookie => cookie.name === 'framework_session')?.value).toBe('');
    const replay = await server.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
    expect(replay.statusCode, replay.body).toBe(401);
    expect(await database.authSession.findUnique({ where: { id: claimsOf(token).sid } })).toBeNull();
    expect((await server.inject({ method: 'GET', url: '/api/auth/me', headers: auth.userHeaders })).statusCode).toBe(200);
  });

  it('applies role changes and account disabling to existing JWT sessions', async () => {
    try {
      await database.user.update({ where: { id: auth.user.id }, data: { role: 'admin' } });
      const current = await server.inject({ method: 'GET', url: '/api/auth/me', headers: auth.userHeaders });
      expect(current.json()).toMatchObject({ user: { id: auth.user.id, role: 'admin' } });
      await database.user.update({ where: { id: auth.user.id }, data: { disabled: true } });
      expect((await server.inject({ method: 'GET', url: '/api/auth/me', headers: auth.userHeaders })).statusCode).toBe(401);
      expect((await login()).statusCode).toBe(401);
    } finally {
      await database.user.update({ where: { id: auth.user.id }, data: { role: 'user', disabled: false } });
    }
  });

  it('bounds password attempts per IP without blocking another client', async () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      const response = await server.inject({
        method: 'POST', url: '/api/auth/login', headers: mutationHeaders,
        payload: { email: auth.user.email, password: 'Wrong-password-for-rate-limit' },
        remoteAddress: '198.51.100.17',
      });
      expect(response.statusCode, response.body).toBe(401);
    }
    const limited = await server.inject({
      method: 'POST', url: '/api/auth/login', headers: mutationHeaders,
      payload: { email: auth.user.email, password: testPassword }, remoteAddress: '198.51.100.17',
    });
    expect(limited.statusCode, limited.body).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect((await login()).statusCode).toBe(200);
  });

  it('registers a regular user, opens a session and ignores attempts to pick a role', async () => {
    const email = `registered-${Date.now()}@example.test`;
    const response = await server.inject({
      method: 'POST', url: '/api/auth/register', headers: mutationHeaders,
      payload: { email: `  ${email.toUpperCase()} `, name: ' New user ', password: testPassword },
      remoteAddress: `192.0.2.${requestAddress++}`,
    });
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json()).toMatchObject({ user: { email, name: 'New user', role: 'user' } });
    const cookie = response.cookies.find(candidate => candidate.name === 'framework_session');
    const current = await server.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: `framework_session=${cookie!.value}` } });
    expect(current.statusCode, current.body).toBe(200);
    const duplicate = await server.inject({
      method: 'POST', url: '/api/auth/register', headers: mutationHeaders,
      payload: { email, name: 'Duplicate', password: testPassword }, remoteAddress: `192.0.2.${requestAddress++}`,
    });
    expect(duplicate.statusCode, duplicate.body).toBe(409);
    for (const payload of [
      { email: 'other@example.test', name: 'Admin', password: testPassword, role: 'admin' },
      { email: 'other@example.test', name: 'Short', password: 'short' },
      { email: 'other@example.test', password: testPassword },
    ]) {
      const invalid = await server.inject({
        method: 'POST', url: '/api/auth/register', headers: mutationHeaders, payload, remoteAddress: `192.0.2.${requestAddress++}`,
      });
      expect(invalid.statusCode, invalid.body).toBe(400);
    }
    const csrf = await server.inject({
      method: 'POST', url: '/api/auth/register', headers: { origin: testAuth.origin },
      payload: { email: 'csrf@example.test', name: 'CSRF', password: testPassword }, remoteAddress: `192.0.2.${requestAddress++}`,
    });
    expect(csrf.statusCode, csrf.body).toBe(403);
  });
});
