import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTelegramClient, escapeHtml, splitMessage, TelegramError } from '../plugins/telegram.js';

const token = '123456:test-secret-bot-token-never-in-errors';

type Seen = { method: string; path: string; body: Record<string, unknown> };
type Handler = (request: Seen, response: ServerResponse) => void;

describe('Telegram plugin against a fake Bot API', () => {
  let server: Server;
  let baseUrl: string;
  let handler: Handler;
  let seen: Seen[];
  let pauses: number[];

  beforeAll(async () => {
    server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      request.on('end', () => {
        // File uploads come as multipart: their raw text is kept for the test to look into.
        const parsed = !body ? {} : request.headers['content-type']?.includes('json') ? JSON.parse(body) as Record<string, unknown> : { multipart: body };
        const entry = { method: request.method ?? '', path: request.url ?? '', body: parsed };
        seen.push(entry);
        handler(entry, response);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  beforeEach(() => { seen = []; pauses = []; });

  const client = (retries = 3) => createTelegramClient({
    token, baseUrl, timeoutMs: 2_000, retries,
    pause: async (ms) => { pauses.push(ms); },
  });
  const json = (response: ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  };

  async function failure(promise: Promise<unknown>): Promise<TelegramError> {
    const error = await promise.then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(TelegramError);
    const telegramError = error as TelegramError;
    expect(`${telegramError.message} ${telegramError.stack} ${JSON.stringify(telegramError)}`).not.toContain(token);
    expect(`${telegramError.message} ${telegramError.stack}`).not.toContain(baseUrl);
    return telegramError;
  }

  it('long-polls getUpdates with the offset and the token in the path', async () => {
    handler = (_request, response) => json(response, 200, {
      ok: true, result: [{ update_id: 7, message: { message_id: 1, chat: { id: 42 }, date: 1, text: '/status' } }],
    });
    const updates = await client().getUpdates(5, { timeoutSeconds: 0 });
    expect(updates).toEqual([{ update_id: 7, message: { message_id: 1, chat: { id: 42 }, date: 1, text: '/status' } }]);
    expect(seen[0]).toMatchObject({ method: 'POST', path: `/bot${token}/getUpdates`, body: { offset: 5, timeout: 0, allowed_updates: ['message', 'callback_query'] } });
  });

  it('sets the «/» menu with setMyCommands', async () => {
    handler = (_request, response) => json(response, 200, { ok: true, result: true });
    await client().setMyCommands([{ command: 'status', description: 'Статус' }]);
    expect(seen[0]).toMatchObject({ path: `/bot${token}/setMyCommands`, body: { commands: [{ command: 'status', description: 'Статус' }] } });
  });

  it('waits retry_after on 429 and tries again', async () => {
    let calls = 0;
    handler = (_request, response) => {
      calls++;
      if (calls === 1) json(response, 429, { ok: false, error_code: 429, description: 'Too Many Requests: retry after 3', parameters: { retry_after: 3 } });
      else json(response, 200, { ok: true, result: { message_id: 9 } });
    };
    await expect(client().sendMessage(42, 'hi')).resolves.toBe(9);
    expect(calls).toBe(2);
    expect(pauses).toEqual([3000]);
  });

  it('gives up after the retries on 429 without the token in the error', async () => {
    handler = (_request, response) => json(response, 429, { ok: false, description: 'Too Many Requests: retry after 1', parameters: { retry_after: 1 } });
    const error = await failure(client(2).sendMessage(42, 'hi'));
    expect(error.status).toBe(429);
    expect(seen).toHaveLength(3);
    expect(pauses).toEqual([1000, 1000]);
  });

  it('does not wait an unreasonable retry_after', async () => {
    handler = (_request, response) => json(response, 429, { ok: false, description: 'Too Many Requests', parameters: { retry_after: 3600 } });
    await failure(client().sendMessage(42, 'hi'));
    expect(seen).toHaveLength(1);
  });

  it('retries 5xx with growing pauses, but not 4xx', async () => {
    let calls = 0;
    handler = (_request, response) => {
      calls++;
      if (calls < 3) json(response, 502, { ok: false, description: 'Bad Gateway' });
      else json(response, 200, { ok: true, result: true });
    };
    await client().answerCallbackQuery('q1', 'ok');
    expect(pauses).toEqual([1000, 2000]);

    seen = [];
    handler = (_request, response) => json(response, 400, { ok: false, error_code: 400, description: 'Bad Request: chat not found' });
    const error = await failure(client().sendMessage(1, 'x'));
    expect(error.message).toBe('Telegram sendMessage: Bad Request: chat not found');
    expect(seen).toHaveLength(1);
  });

  it('hides the URL of a network failure', async () => {
    const offline = createTelegramClient({ token, baseUrl: 'http://127.0.0.1:1', timeoutMs: 1_000, retries: 1, pause: async () => {} });
    const error = await failure(offline.sendMessage(1, 'x'));
    expect(error.status).toBeNull();
  });

  it('sends HTML with inline buttons and splits long text', async () => {
    handler = (_request, response) => json(response, 200, { ok: true, result: { message_id: seen.length } });
    const long = Array.from({ length: 900 }, (_, index) => `line ${index}`).join('\n');
    const id = await client().sendMessage(42, long, { keyboard: [[{ text: 'вкл', data: 's:on:1' }]] });
    expect(seen.length).toBeGreaterThan(1);
    expect(id).toBe(seen.length);
    for (const request of seen) expect((request.body.text as string).length).toBeLessThanOrEqual(4096);
    expect(seen.map((request) => request.body.text).join('\n')).toBe(long);
    expect(seen.at(-1)!.body).toMatchObject({ parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: 'вкл', callback_data: 's:on:1' }]] } });
    expect(seen[0]!.body.reply_markup).toBeUndefined();
  });

  it('uploads screenshots: one as sendPhoto, more as albums of ten with the caption on the first', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'tg-photos-'));
    try {
      const files = Array.from({ length: 11 }, (_, index) => {
        const file = path.join(dir, `${String(index + 1).padStart(3, '0')}.png`);
        writeFileSync(file, `png-${index + 1}`);
        return file;
      });
      handler = (_request, response) => json(response, 200, { ok: true, result: [] });
      await client().sendPhotos(42, files, 'Node &lt;Dev&gt; — Acme');
      expect(seen.map((item) => item.path)).toEqual([`/bot${token}/sendMediaGroup`, `/bot${token}/sendPhoto`]);
      const album = String(seen[0]!.body.multipart);
      expect(album).toContain('"media":"attach://p0","caption":"Node &lt;Dev&gt; — Acme","parse_mode":"HTML"');
      expect(album).toContain('attach://p9');
      expect(album).toContain('png-10');
      expect(album).not.toContain('png-11');
      const single = String(seen[1]!.body.multipart);
      expect(single).toContain('png-11');
      expect(single).not.toContain('caption');

      seen = [];
      await client().sendPhotos(42, [files[0]!], 'one');
      expect(seen.map((item) => item.path)).toEqual([`/bot${token}/sendPhoto`]);
      expect(String(seen[0]!.body.multipart)).toMatch(/name="caption"\r\n\r\none/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('treats "message is not modified" on edit as success', async () => {
    handler = (_request, response) => json(response, 400, { ok: false, description: 'Bad Request: message is not modified' });
    await expect(client().editMessageText(42, 1, 'same')).resolves.toBeUndefined();
  });

  it('escapes HTML and cuts an overlong line', () => {
    expect(escapeHtml('<a> & b')).toBe('&lt;a&gt; &amp; b');
    expect(splitMessage('x'.repeat(10), 4)).toEqual(['xxxx', 'xxxx', 'xx']);
    expect(splitMessage('ab\ncd\nef', 5)).toEqual(['ab\ncd', 'ef']);
  });
});
