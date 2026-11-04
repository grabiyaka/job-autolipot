import { jobTrackerConfigFromEnv } from './plugins/environment.js';
import { createJobTrackerClient } from './plugins/job-tracker.js';
import { buildServer } from './app.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required. See .env.example or docker compose.');
const secret = process.env.JWT_SECRET;
const origin = process.env.APP_ORIGIN;
if (!secret || !origin) throw new Error('JWT_SECRET and APP_ORIGIN are required. See ../.env.example.');
if (process.env.COOKIE_SECURE !== undefined && !['true', 'false'].includes(process.env.COOKIE_SECURE)) {
  throw new Error('COOKIE_SECURE must be true or false.');
}

const trackerConfig = jobTrackerConfigFromEnv();

const server = await buildServer({
  databaseUrl,
  tracker: trackerConfig && createJobTrackerClient(trackerConfig),
  logger: true,
  auth: {
    secret,
    origin,
    allowedOrigins: process.env.AUTH_ALLOWED_ORIGINS?.split(',').map((value) => value.trim()).filter(Boolean) ?? [],
    ...(process.env.COOKIE_SECURE !== undefined ? { cookieSecure: process.env.COOKIE_SECURE === 'true' } : {}),
    ...(process.env.JWT_TTL_SECONDS !== undefined ? { sessionTtlSeconds: Number(process.env.JWT_TTL_SECONDS) } : {}),
  },
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void server.close().catch((error: unknown) => { server.log.error(error); process.exitCode = 1; }); });
}
await server.listen({ port: Number(process.env.PORT ?? 3400), host: process.env.HOST ?? '127.0.0.1' });
