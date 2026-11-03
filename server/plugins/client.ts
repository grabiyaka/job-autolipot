import { existsSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

/** Serve the production Vue build; Vite owns client delivery during development. */
export async function registerClient(server: FastifyInstance, directory = resolve('../client/dist')): Promise<void> {
  const hasClient = existsSync(resolve(directory, 'index.html'));
  if (hasClient) {
    await server.register(fastifyStatic, { root: directory, index: 'index.html', wildcard: true });
  }
  server.setNotFoundHandler((request, reply) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const acceptsHtml = request.headers.accept?.includes('text/html') ?? false;
    if (hasClient && (request.method === 'GET' || request.method === 'HEAD') && acceptsHtml
      && !/^\/(?:api|docs)(?:\/|$)/.test(pathname) && !extname(pathname)) {
      return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
    }
    return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Маршрут не найден.', requestId: request.id } });
  });
}
