import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { connectMcp, parseRpcBody } from '../plugins/mcp-client.js';
import { remoteBrowser, runCodeResult } from '../plugins/remote-browser.js';
import type { RemoteBrowserController, RemoteBrowserEnd } from '../plugins/remote-browser.js';
import { parseRemoteAction, startRemoteBrowserServer } from '../plugins/remote-browser-server.js';
import type { RemoteBrowserServer } from '../plugins/remote-browser-server.js';

/** A controller without a browser: what it was asked to do. */
function fakeController() {
  const calls: string[] = [];
  const controller: RemoteBrowserController = {
    open: async (url) => { calls.push(`open ${url}`); },
    frame: async () => { calls.push('frame'); return { jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), url: 'https://acme.example/путь?a=1' }; },
    tap: async (x, y) => { calls.push(`tap ${x},${y}`); },
    scroll: async (dy) => { calls.push(`scroll ${dy}`); },
    insertText: async (text) => { calls.push(`text ${text}`); },
    press: async (key) => { calls.push(`key ${key}`); },
    back: async () => { calls.push('back'); },
    reload: async () => { calls.push('reload'); },
    goto: async (url) => { calls.push(`goto ${url}`); },
    resize: async (height) => { calls.push(`resize ${height}`); },
    currentUrl: async () => 'https://acme.example/',
    close: async () => { calls.push('close'); },
  };
  return { controller, calls };
}

describe('remote browser page server', () => {
  let server: RemoteBrowserServer | null = null;
  afterEach(async () => { await server?.close(); server = null; });

  async function start(options: { now?: () => number; idleMs?: number; maxMs?: number } = {}) {
    const fake = fakeController();
    const expired: RemoteBrowserEnd[] = [];
    server = await startRemoteBrowserServer({
      controller: fake.controller, port: 0, publicUrl: 'https://rb.example.test:8444/',
      idleMs: options.idleMs ?? 30 * 60_000, maxMs: options.maxMs ?? 60 * 60_000, onExpire: (reason) => expired.push(reason),
      ...(options.now ? { now: options.now } : {}),
    });
    const base = `http://127.0.0.1:${server.port}`;
    const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { ...fake, expired, base, post, token: server.token };
  }

  it('serves the page, the frame and actions only under the token; anything else is 404', async () => {
    const { base, token, calls, post } = await start();
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(server!.link).toBe(`https://rb.example.test:8444/s/${token}`);

    const page = await fetch(`${base}/s/${token}`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toMatch(/text\/html/);
    expect(page.headers.get('cache-control')).toBe('no-store');
    const html = await page.text();
    expect(html).toContain(`const base = "/s/${token}"`);
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).toContain('Отправить');

    const frame = await fetch(`${base}/s/${token}/frame.jpg`);
    expect(frame.status).toBe(200);
    expect(frame.headers.get('content-type')).toBe('image/jpeg');
    expect(decodeURIComponent(frame.headers.get('x-page-url')!)).toBe('https://acme.example/путь?a=1');
    expect(Buffer.from(await frame.arrayBuffer())).toEqual(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

    expect((await post(`/s/${token}/action`, { type: 'tap', x: 100, y: 200.5 })).status).toBe(200);
    await post(`/s/${token}/action`, { type: 'scroll', dy: -300 });
    await post(`/s/${token}/action`, { type: 'text', text: 'Иван "</script>' });
    await post(`/s/${token}/action`, { type: 'key', key: 'Enter' });
    await post(`/s/${token}/action`, { type: 'back' });
    const refused = await post(`/s/${token}/action`, { type: 'key', key: 'Control+A' });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ ok: false });
    expect(calls).toEqual(['frame', 'tap 100,200.5', 'scroll -300', 'text Иван "</script>', 'key Enter', 'back']);

    const wrong = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
    for (const path of ['/', '/s', `/s/${wrong}`, `/s/${wrong}/frame.jpg`, `/s/${token}/other`, `/s/${token}x`, `/${token}`]) {
      expect((await fetch(`${base}${path}`)).status, path).toBe(404);
    }
    expect((await post(`/s/${wrong}/action`, { type: 'back' })).status).toBe(404);
    expect(calls).toHaveLength(6);
  });

  it('expires after 30 minutes without actions (frames do not count) and after the hard cap', async () => {
    let time = 1_000_000;
    const { base, token, post, expired, calls } = await start({ now: () => time });
    time += 20 * 60_000;
    expect((await fetch(`${base}/s/${token}/frame.jpg`)).status).toBe(200);
    expect((await post(`/s/${token}/action`, { type: 'scroll', dy: 100 })).status).toBe(200);
    time += 29 * 60_000;
    expect((await fetch(`${base}/s/${token}/frame.jpg`)).status).toBe(200);
    time += 2 * 60_000;
    expect((await fetch(`${base}/s/${token}/frame.jpg`)).status).toBe(404);
    expect((await fetch(`${base}/s/${token}`)).status).toBe(404);
    expect(expired).toEqual(['idle']);
    expect(calls.filter((call) => call !== 'frame')).toEqual(['scroll 100']);

    await server!.close();
    time = 0;
    const capped = await start({ now: () => time, idleMs: 30 * 60_000, maxMs: 60 * 60_000 });
    for (let minute = 0; minute < 60; minute += 20) {
      time = minute * 60_000;
      expect((await capped.post(`/s/${capped.token}/action`, { type: 'back' })).status).toBe(200);
    }
    time = 60 * 60_000;
    expect((await capped.post(`/s/${capped.token}/action`, { type: 'back' })).status).toBe(404);
    expect(capped.expired).toEqual(['max']);
  });

  it('checks actions', () => {
    expect(parseRemoteAction({ type: 'tap', x: 1, y: 2 })).toEqual({ type: 'tap', x: 1, y: 2 });
    expect(parseRemoteAction({ type: 'tap', x: '1', y: 2 })).toMatch(/tap/);
    expect(parseRemoteAction({ type: 'scroll', dy: 10.6 })).toEqual({ type: 'scroll', dy: 11 });
    expect(parseRemoteAction({ type: 'text', text: '' })).toMatch(/text/);
    expect(parseRemoteAction({ type: 'goto', url: 'javascript:alert(1)' })).toMatch(/http/);
    expect(parseRemoteAction({ type: 'goto', url: 'https://acme.example/a' })).toEqual({ type: 'goto', url: 'https://acme.example/a' });
    expect(parseRemoteAction({ type: 'resize', height: 100 })).toMatch(/resize/);
    expect(parseRemoteAction({ type: 'eval' })).toBe('неизвестное действие');
    expect(parseRemoteAction(null)).toMatch(/JSON/);
  });

  it('the session opens the URL after the server is up, and closing stops both', async () => {
    const fake = fakeController();
    const port = remoteBrowser({ mcpUrl: 'http://unused', port: 0, publicUrl: 'https://rb.example.test' }, () => fake.controller);
    const session = await port.open('https://acme.wd3.myworkdayjobs.com/job/1', () => {});
    expect(session.link).toMatch(/^https:\/\/rb\.example\.test\/s\/[A-Za-z0-9_-]{32}$/);
    expect(fake.calls).toEqual(['open https://acme.wd3.myworkdayjobs.com/job/1']);
    await session.close();
    await session.close();
    expect(fake.calls).toEqual(['open https://acme.wd3.myworkdayjobs.com/job/1', 'close']);
  });
});

describe('Playwright MCP client', () => {
  let mcp: Server | null = null;
  afterEach(async () => { await new Promise<void>((resolve) => { if (!mcp) { resolve(); return; } mcp.closeAllConnections(); mcp.close(() => resolve()); }); mcp = null; });

  it('reads JSON and SSE answers', () => {
    expect(parseRpcBody('{"jsonrpc":"2.0","id":2,"result":{"a":1}}', 'application/json', 2)).toMatchObject({ result: { a: 1 } });
    const sse = 'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/x"}\n\nevent: message\ndata: {"jsonrpc":"2.0","id":3,"result":{"ok":true}}\n\n';
    expect(parseRpcBody(sse, 'text/event-stream', 3)).toMatchObject({ result: { ok: true } });
    expect(parseRpcBody(sse, 'text/event-stream', 4)).toBeNull();
  });

  it('reads the result of browser_run_code_unsafe and its errors', () => {
    expect(runCodeResult({ content: [{ type: 'text', text: '### Result\n{"data":"/9j/","url":"https://a.example/"}\n\n### Ran Playwright code\n```js\n```' }] }))
      .toEqual({ data: '/9j/', url: 'https://a.example/' });
    expect(runCodeResult({ content: [{ type: 'text', text: '### Result\n"https://a.example/"\n### Ran Playwright code' }] })).toBe('https://a.example/');
    expect(runCodeResult({ content: [{ type: 'text', text: '### Ran Playwright code\n```js\n```' }] })).toBeUndefined();
    expect(() => runCodeResult({ isError: true, content: [{ type: 'text', text: '### Error\nTimeoutError: page.goto' }] })).toThrow(/TimeoutError: page.goto/);
  });

  it('initializes a session, calls tools with its id and deletes it', async () => {
    const seen: { method: string; session: string | undefined; body: Record<string, unknown> | null }[] = [];
    mcp = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      request.on('end', () => {
        const data = body ? JSON.parse(body) as Record<string, unknown> : null;
        seen.push({ method: request.method ?? '', session: request.headers['mcp-session-id'] as string | undefined, body: data });
        if (request.method === 'DELETE' || !data || data.id === undefined) { response.writeHead(request.method === 'DELETE' ? 200 : 202).end(); return; }
        const result = data.method === 'initialize' ? { protocolVersion: '2025-03-26', capabilities: {} } : { content: [{ type: 'text', text: '### Result\n42' }] };
        response.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 'sess-1' });
        response.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: data.id, result })}\n\n`);
      });
    });
    await new Promise<void>((resolve) => mcp!.listen(0, '127.0.0.1', resolve));
    const client = await connectMcp({ url: `http://127.0.0.1:${(mcp.address() as AddressInfo).port}/mcp` });
    const result = await client.callTool('browser_run_code_unsafe', { code: 'async (page) => 42' });
    expect(runCodeResult(result)).toBe(42);
    await client.close();
    await client.close();
    expect(seen.map((item) => [item.method, item.session, item.body?.method ?? null])).toEqual([
      ['POST', undefined, 'initialize'],
      ['POST', 'sess-1', 'notifications/initialized'],
      ['POST', 'sess-1', 'tools/call'],
      ['DELETE', 'sess-1', null],
    ]);
    expect(seen[2]!.body).toMatchObject({ params: { name: 'browser_run_code_unsafe', arguments: { code: 'async (page) => 42' } } });
  });
});
