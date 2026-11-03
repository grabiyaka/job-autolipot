import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBrokerBrowser } from '../plugins/browser-broker.js';
import { BrowserBlockedError, BrowserError, BrowserUnavailableError } from '../src/searches/SearchTypes.js';

type Request = { action: string; args: Record<string, unknown> };
/** Returns the raw reply line, or null to keep the connection open without answering. */
type Handler = (request: Request) => string | null;

const ok = (result: object) => JSON.stringify({ ok: true, result });

describe('browser broker plugin', () => {
  let directory: string;
  let socketPath: string;
  let server: Server | undefined;
  let requests: Request[];

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'broker-test-'));
    socketPath = path.join(directory, 'broker.sock');
    requests = [];
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
    rmSync(directory, { recursive: true, force: true });
  });

  /** A fake broker: one newline-terminated JSON request per connection, like the real one. */
  async function broker(handler: Handler): Promise<void> {
    server = createServer((socket: Socket) => {
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        if (!buffer.includes('\n')) return;
        const request = JSON.parse(buffer) as Request;
        requests.push(request);
        const reply = handler(request);
        if (reply !== null) socket.end(`${reply}\n`);
      });
      socket.on('error', () => {});
    });
    await new Promise<void>((resolve) => server!.listen(socketPath, resolve));
  }

  it('opens a page and reports the current one', async () => {
    await broker(({ action }) => action === 'open'
      ? ok({ url: 'https://www.linkedin.com/jobs/', title: 'Jobs', status: 200 })
      : ok({ open: true, url: 'https://www.linkedin.com/jobs/', title: 'Jobs' }));
    const browser = createBrokerBrowser({ socketPath });
    expect(await browser.open('https://www.linkedin.com/jobs/')).toEqual({ url: 'https://www.linkedin.com/jobs/', title: 'Jobs', status: 200 });
    expect(await browser.currentPage()).toEqual({ url: 'https://www.linkedin.com/jobs/', title: 'Jobs' });
    expect(requests).toEqual([
      { action: 'open', args: { url: 'https://www.linkedin.com/jobs/' } },
      { action: 'current_page', args: {} },
    ]);
  });

  it('returns null when nothing is open and status null when the browser reports none', async () => {
    await broker(({ action }) => action === 'open' ? ok({ url: 'https://a.test/', title: 'A' }) : ok({ open: false }));
    const browser = createBrokerBrowser({ socketPath });
    expect(await browser.currentPage()).toBeNull();
    expect((await browser.open('https://a.test/')).status).toBeNull();
  });

  it('joins page text from chunks and links from pages', async () => {
    const text = 'x'.repeat(4000) + 'y'.repeat(1000);
    await broker(({ action, args }) => {
      const offset = args.offset as number;
      if (action === 'get_text') {
        const end = Math.min(offset + 4000, text.length);
        return ok({ url: 'https://a.test/', title: 'A', source: 'main', offset, end, total: text.length, text: text.slice(offset, end) });
      }
      const all = Array.from({ length: 250 }, (_, index) => ({ href: `https://a.test/${index}`, text: `L${index}` }));
      const end = Math.min(offset + 200, all.length);
      return ok({ url: 'https://a.test/', title: 'A', source: 'main', offset, end, total: all.length, filtered: 3, html_truncated: false, links: all.slice(offset, end) });
    });
    const browser = createBrokerBrowser({ socketPath });
    expect(await browser.text()).toEqual({ url: 'https://a.test/', text });
    const { links } = await browser.links();
    expect(links).toHaveLength(250);
    expect(links[249]).toEqual({ href: 'https://a.test/249', text: 'L249' });
    expect(requests.map((request) => [request.action, request.args.offset])).toEqual([
      ['get_text', 0], ['get_text', 4000], ['get_links', 0], ['get_links', 200],
    ]);
  });

  it('reads links again when the broker asks to, but not forever', async () => {
    let calls = 0;
    await broker(() => {
      calls++;
      return calls < 3
        ? JSON.stringify({ ok: false, error: 'page changed while reading links; call get_links again' })
        : ok({ url: 'https://a.test/', title: 'A', source: 'main', offset: 0, end: 1, total: 1, filtered: 0, html_truncated: false, links: [{ href: 'https://a.test/1', text: 'One' }] });
    });
    expect((await createBrokerBrowser({ socketPath }).links()).links).toEqual([{ href: 'https://a.test/1', text: 'One' }]);
    expect(calls).toBe(3);

    calls = -100;
    await expect(createBrokerBrowser({ socketPath }).links()).rejects.toThrow(/call get_links again/);
    expect(calls).toBe(-96);
  });

  it('fails instead of mixing two pages when the tab navigates mid-read', async () => {
    let call = 0;
    await broker(({ args }) => {
      call++;
      const offset = args.offset as number;
      return ok({ url: call === 1 ? 'https://a.test/' : 'https://b.test/', title: '', source: 'main', offset, end: offset + 10, total: 20, text: 'z'.repeat(10) });
    });
    await expect(createBrokerBrowser({ socketPath }).text()).rejects.toThrow(/page changed while reading text/);
  });

  it('scrolls down only within 1–5 screens', async () => {
    await broker(() => ok({ url: 'https://a.test/', scrolled: true }));
    const browser = createBrokerBrowser({ socketPath });
    await browser.scroll(2);
    expect(requests).toEqual([{ action: 'scroll', args: { direction: 'down', screens: 2 } }]);
    await expect(browser.scroll(6)).rejects.toBeInstanceOf(BrowserError);
    expect(requests).toHaveLength(1);
  });

  it('classifies refusals, broker errors and malformed replies', async () => {
    const replies = [
      JSON.stringify({ ok: false, error: 'blocked by browser policy: https://evil.test/ is not allow-listed' }),
      JSON.stringify({ ok: false, error: 'navigation failed' }),
      'not json',
      ok({ url: 42, title: 'A' }),
    ];
    await broker(() => replies.shift()!);
    const browser = createBrokerBrowser({ socketPath });
    await expect(browser.open('https://evil.test/')).rejects.toBeInstanceOf(BrowserBlockedError);
    const failed = await browser.open('https://a.test/').catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(BrowserError);
    expect(failed).not.toBeInstanceOf(BrowserBlockedError);
    expect(failed).not.toBeInstanceOf(BrowserUnavailableError);
    await expect(browser.open('https://a.test/')).rejects.toThrow('malformed broker response: not JSON');
    await expect(browser.open('https://a.test/')).rejects.toThrow('field "url" missing or not string');
  });

  it('reports a missing broker and a silent one as unavailable', async () => {
    await expect(createBrokerBrowser({ socketPath }).ping()).rejects.toBeInstanceOf(BrowserUnavailableError);
    await broker(() => null);
    await expect(createBrokerBrowser({ socketPath, timeoutMs: 100 }).ping()).rejects.toThrow(/did not answer within 0.1s/);
  });

  it('stops waiting when the run is aborted and rejects oversized replies', async () => {
    await broker(({ action }) => action === 'ping' ? null : ok({ url: 'https://a.test/', title: 'x'.repeat(5000) }));
    const controller = new AbortController();
    const pending = createBrokerBrowser({ socketPath }).ping(controller.signal);
    setTimeout(() => controller.abort(new Error('run stopped')), 20);
    await expect(pending).rejects.toThrow('run stopped');
    await expect(createBrokerBrowser({ socketPath, maxResponseBytes: 1000 }).open('https://a.test/')).rejects.toThrow(/larger than 1000 bytes/);
  });
});
