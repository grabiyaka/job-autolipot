import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createOllamaClient, OllamaHttpError, OllamaResponseError, OllamaUnavailableError,
} from '../plugins/ollama.js';
import type { OllamaConfig } from '../plugins/ollama.js';
import { ollamaConfigFromEnv } from '../plugins/environment.js';

type Reply = Readonly<{ status?: number; body: unknown; delayMs?: number }>;

const servers: Server[] = [];
afterEach(() => { for (const server of servers.splice(0)) { server.closeAllConnections(); server.close(); } });

/** A fake Ollama that answers /api/chat with the queued replies and records the request bodies. */
async function fakeOllama(replies: Reply[]) {
  const requests: Record<string, unknown>[] = [];
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk: Buffer) => { raw += chunk.toString(); });
    request.on('end', () => {
      requests.push(JSON.parse(raw) as Record<string, unknown>);
      const reply = replies.shift() ?? { status: 500, body: { error: 'no reply queued' } };
      setTimeout(() => {
        response.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(reply.body));
      }, reply.delayMs ?? 0);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, requests };
}

function chat(content: string, extra: Record<string, unknown> = {}) {
  return {
    model: 'test-model', done: true, done_reason: 'stop', prompt_eval_count: 900, eval_count: 40,
    message: { role: 'assistant', content }, ...extra,
  };
}

const parseNumber = (content: string): number => {
  const value = (JSON.parse(content) as { n?: unknown }).n;
  if (typeof value !== 'number') throw new Error('n is not a number');
  return value;
};

const request = { system: 'rules', user: 'job', schema: { type: 'object' } };

function client(baseUrl: string, overrides: Partial<OllamaConfig> = {}) {
  return createOllamaClient({ baseUrl, model: 'test-model', numCtx: 4096, numPredict: 1024, timeoutMs: 2000, ...overrides });
}

describe('Ollama plugin', () => {
  it('sends a non-streaming chat with think off, format and options, and returns the parsed value', async () => {
    const ollama = await fakeOllama([{ body: chat('{"n": 7}') }]);
    const result = await client(ollama.baseUrl).chatJson(request, parseNumber);

    expect(result).toMatchObject({ value: 7, model: 'test-model', promptTokens: 900, evalTokens: 40, attempts: 1 });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(ollama.requests).toEqual([{
      model: 'test-model',
      messages: [{ role: 'system', content: 'rules' }, { role: 'user', content: 'job' }],
      format: { type: 'object' },
      stream: false,
      think: false,
      options: { num_ctx: 4096, num_predict: 1024, temperature: 0 },
    }]);
  });

  it('uses the per-call model', async () => {
    const ollama = await fakeOllama([{ body: chat('{"n": 1}', { model: 'other' }) }]);
    const result = await client(ollama.baseUrl).chatJson({ ...request, model: 'other' }, parseNumber);
    expect(ollama.requests[0]?.model).toBe('other');
    expect(result.model).toBe('other');
  });

  it('retries once when the answer does not parse', async () => {
    const ollama = await fakeOllama([{ body: chat('{"n": ') }, { body: chat('{"n": 3}') }]);
    const result = await client(ollama.baseUrl).chatJson(request, parseNumber);
    expect(result).toMatchObject({ value: 3, attempts: 2, promptTokens: 1800, evalTokens: 80 });
    expect(ollama.requests).toHaveLength(2);
  });

  it('fails after two answers that do not parse, quoting the answer', async () => {
    const ollama = await fakeOllama([{ body: chat('broken one') }, { body: chat('{"n": "x"}') }]);
    const error = await client(ollama.baseUrl).chatJson(request, parseNumber).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OllamaResponseError);
    expect((error as Error).message).toContain('n is not a number');
    expect((error as Error).message).toContain('{"n": "x"}');
    expect(ollama.requests).toHaveLength(2);
  });

  it('rejects an answer cut by the output limit without retrying', async () => {
    const ollama = await fakeOllama([{ body: chat('{"n": 1', { done_reason: 'length' }) }]);
    await expect(client(ollama.baseUrl).chatJson(request, parseNumber)).rejects.toThrow(/done_reason "length"/);
    expect(ollama.requests).toHaveLength(1);
  });

  it('rejects an answer whose prompt did not leave room for the output', async () => {
    const ollama = await fakeOllama([{ body: chat('{"n": 1}', { prompt_eval_count: 3073 }) }]);
    const error = await client(ollama.baseUrl).chatJson(request, parseNumber).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OllamaResponseError);
    expect((error as Error).message).toMatch(/3073.*3072/);
  });

  it('accepts a prompt exactly at the limit', async () => {
    const ollama = await fakeOllama([{ body: chat('{"n": 1}', { prompt_eval_count: 3072 }) }]);
    await expect(client(ollama.baseUrl).chatJson(request, parseNumber)).resolves.toMatchObject({ value: 1 });
  });

  it('rejects a response without an assistant message', async () => {
    const ollama = await fakeOllama([{ body: chat('', { message: { role: 'assistant' } }) }]);
    await expect(client(ollama.baseUrl).chatJson(request, parseNumber)).rejects.toBeInstanceOf(OllamaResponseError);
  });

  it('reports a timeout as unavailable', async () => {
    const ollama = await fakeOllama([{ body: chat('{"n": 1}'), delayMs: 500 }]);
    const error = await client(ollama.baseUrl, { timeoutMs: 100 }).chatJson(request, parseNumber).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OllamaUnavailableError);
    expect((error as Error).message).toContain('100 мс');
  });

  it('reports a refused connection as unavailable', async () => {
    const ollama = await fakeOllama([]);
    const server = servers.pop()!;
    await new Promise((resolve) => server.close(resolve));
    await expect(client(ollama.baseUrl).chatJson(request, parseNumber)).rejects.toBeInstanceOf(OllamaUnavailableError);
  });

  it('turns an Ollama HTTP error into a readable error', async () => {
    const ollama = await fakeOllama([{ status: 404, body: { error: "model 'nope' not found" } }]);
    const error = await client(ollama.baseUrl).chatJson(request, parseNumber).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OllamaHttpError);
    expect(error).toMatchObject({ status: 404, message: "Ollama HTTP 404: model 'nope' not found" });
  });

  it('validates the configuration', () => {
    expect(() => client('localhost:11434')).toThrow(/http/);
    expect(() => client('http://x', { numCtx: 1024 })).toThrow(/num_ctx/);
  });

  it('reads OLLAMA_* settings with defaults', () => {
    expect(ollamaConfigFromEnv({})).toEqual({
      baseUrl: 'http://127.0.0.1:11434', model: 'qwen3.5:4b', numCtx: 8192, numPredict: 1024, timeoutMs: 120000,
    });
    expect(ollamaConfigFromEnv({ OLLAMA_MODEL: 'qwen3:8b', OLLAMA_NUM_CTX: '16384', OLLAMA_TIMEOUT_MS: '5000' }))
      .toMatchObject({ model: 'qwen3:8b', numCtx: 16384, timeoutMs: 5000 });
    expect(() => ollamaConfigFromEnv({ OLLAMA_NUM_CTX: '8k' })).toThrow(/OLLAMA_NUM_CTX/);
  });
});
