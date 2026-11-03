import cookie from '@fastify/cookie';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';
import { ApplicationError } from '../framework/core/errors.js';
import type { UserApi } from '../src/users/UserTypes.js';
import { registerRequestIdentity } from './requestIdentity.js';

export const SESSION_COOKIE = 'framework_session';

export type AuthenticationOptions = Readonly<{
  secret: string;
  origin: string;
  allowedOrigins?: readonly string[];
  cookieSecure?: boolean;
  sessionTtlSeconds?: number;
}>;

function requireOrigin(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error('Authentication origins must be canonical HTTP(S) origins.'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || value !== parsed.origin) {
    throw new Error('Authentication origins must be canonical HTTP(S) origins without paths.');
  }
  return parsed.origin;
}

export function authenticationSettings(options: AuthenticationOptions) {
  if (typeof options.secret !== 'string' || Buffer.byteLength(options.secret) < 32) {
    throw new Error('JWT_SECRET must contain at least 32 bytes. Generate a cryptographically random secret.');
  }
  const origin = requireOrigin(options.origin);
  const origins = new Set([origin, ...(options.allowedOrigins ?? []).map(requireOrigin)]);
  const sessionTtlSeconds = options.sessionTtlSeconds ?? 3600;
  if (!Number.isInteger(sessionTtlSeconds) || sessionTtlSeconds < 60 || sessionTtlSeconds > 86_400) {
    throw new Error('JWT_TTL_SECONDS must be an integer between 60 and 86400.');
  }
  return { secret: options.secret, origins, sessionTtlSeconds, cookieSecure: options.cookieSecure ?? origin.startsWith('https:') };
}

type JwtClaims = Readonly<{ sub?: unknown; sid?: unknown }>;

export async function registerAuthentication(
  server: FastifyInstance,
  users: UserApi,
  settings: ReturnType<typeof authenticationSettings>,
): Promise<void> {
  await server.register(cookie);
  await server.register(jwt, {
    secret: settings.secret,
    cookie: { cookieName: SESSION_COOKIE, signed: false },
    sign: { algorithm: 'HS256', iss: 'jwx-framework', aud: 'jwx-framework-client' },
    verify: {
      algorithms: ['HS256'], allowedIss: 'jwx-framework', allowedAud: 'jwx-framework-client',
      requiredClaims: ['sub', 'sid', 'exp', 'iss', 'aud'],
    },
  });
  await server.register(rateLimit, { global: false, max: 10, timeWindow: '1 minute' });
  registerRequestIdentity(server);

  server.addHook('onRequest', async (request) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const origin = request.headers.origin;
      if (origin !== undefined && !settings.origins.has(origin)) {
        throw new ApplicationError('ORIGIN_REJECTED', 'Источник запроса не разрешён.', 403);
      }
      // Use Fastify's matched route; URL-encoded spelling must not bypass auth-route protection.
      const path = request.routeOptions.url;
      const cookieAuthentication = Boolean(request.cookies[SESSION_COOKIE]);
      const browserMutation = cookieAuthentication || path === '/api/auth/login' || path === '/api/auth/logout';
      if (browserMutation && request.headers['sec-fetch-site'] === 'cross-site') {
        throw new ApplicationError('CSRF_REJECTED', 'Межсайтовый запрос не разрешён.', 403);
      }
      if (browserMutation && request.headers['x-requested-with'] !== 'XMLHttpRequest') {
        throw new ApplicationError('CSRF_REJECTED', 'Нужен заголовок X-Requested-With: XMLHttpRequest.', 403);
      }
    }

    const authorization = request.headers.authorization;
    if (authorization !== undefined && !/^Bearer [^\s]+$/i.test(authorization)) return;
    if (!authorization && !request.cookies[SESSION_COOKIE]) return;
    let claims: JwtClaims;
    try { claims = await request.jwtVerify<JwtClaims>({ onlyCookie: !authorization }); } catch { return; }
    if (typeof claims.sub !== 'string' || typeof claims.sid !== 'string') return;
    // JWT proves token ownership; the database controls revocation, role changes and disabled accounts.
    const session = await users.session(claims.sid, claims.sub);
    if (session) {
      request.authSession = session;
      request.actor = session.actor;
    }
  });
}
