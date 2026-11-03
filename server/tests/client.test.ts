import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerClient } from '../plugins/client.js';

describe('production client routing', () => {
  const server = Fastify();
  let directory: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'jwx-client-'));
    await writeFile(join(directory, 'index.html'), '<html><body>Client application</body></html>');
    await writeFile(join(directory, 'application.js'), 'console.log("client");');
    server.get('/api/health', async () => ({ status: 'ok' }));
    await registerClient(server, directory);
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('serves the client and supports direct navigation to Vue routes', async () => {
    for (const url of ['/', '/login', '/tasks', '/profile']) {
      const response = await server.inject({ url, headers: { accept: 'text/html' } });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('Client application');
    }
    const script = await server.inject('/application.js');
    expect(script.statusCode).toBe(200);
    expect(script.headers['content-type']).toContain('javascript');
  });

  it('does not replace missing API, documentation, assets or writes with HTML', async () => {
    for (const url of ['/api/missing', '/api', '/docs/missing', '/missing.js', '/missing.css']) {
      const response = await server.inject({ url, headers: { accept: 'text/html' } });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    }
    expect((await server.inject({ method: 'POST', url: '/tasks', headers: { accept: 'text/html' } })).statusCode).toBe(404);
    expect((await server.inject('/unrecognized-json-request')).statusCode).toBe(404);
    expect((await server.inject('/api/health')).json()).toEqual({ status: 'ok' });
  });
});

it('keeps the API error format when no client build exists during development', async () => {
  const server = Fastify();
  try {
    await registerClient(server, join(tmpdir(), 'nonexistent-jwx-client-build'));
    const response = await server.inject({ url: '/tasks', headers: { accept: 'text/html' } });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  } finally { await server.close(); }
});
