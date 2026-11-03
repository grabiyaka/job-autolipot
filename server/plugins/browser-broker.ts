import { createConnection } from 'node:net';
import { BrowserBlockedError, BrowserError, BrowserUnavailableError } from '../src/searches/SearchTypes.js';
import type { Browser, BrowserLink, BrowserPage } from '../src/searches/SearchTypes.js';

/**
 * Read-only client of local-agent's browser broker (the agent Chromium on the home server).
 *
 * Protocol (owned by local-agent, README "Broker protocol"): one request per Unix-socket connection,
 * newline-terminated JSON both ways, then the broker closes the connection:
 *   -> {"action": "open", "args": {"url": "https://..."}}
 *   <- {"ok": true, "result": {...}}  |  {"ok": false, "error": "..."}
 * The broker decides access (peer uid, URL allow-list); this client adds none of its own and
 * sends only open, current_page, get_text, get_links, scroll and ping.
 */

export const defaultBrokerSocket = '/run/agent-browser/broker.sock';

export type BrokerOptions = Readonly<{
  socketPath: string;
  /** The broker gives up on an action after 90 s. */
  timeoutMs?: number;
  maxResponseBytes?: number;
}>;

export type BrokerStatus = Readonly<{ connected: boolean; chromium: string; allowList: string }>;
export type BrokerBrowser = Browser & Readonly<{ ping(signal?: AbortSignal): Promise<BrokerStatus> }>;

type Result = Record<string, unknown>;

const textChunk = 4000; // broker maximum per get_text call
const maxTextCalls = 60; // the broker caps page text at 200,000 chars = 50 chunks
const linkPage = 200; // broker maximum per get_links call
const maxLinkCalls = 30;
const blockedPrefixes = ['blocked by browser policy', 'peer uid not allowed'];
/** The broker asks to read links again when the page re-renders mid-read (seen on LinkedIn). */
const linksAgain = 'call get_links again';
const linkRestarts = 3;

function field<T extends 'string' | 'number' | 'boolean' | 'object'>(
  data: Result, name: string, kind: T,
): T extends 'string' ? string : T extends 'number' ? number : T extends 'boolean' ? boolean : unknown {
  const value = data[name];
  const valid = kind === 'number' ? Number.isInteger(value) : kind === 'object' ? Array.isArray(value) : typeof value === kind;
  if (!valid) throw new BrowserError(`malformed broker response: field "${name}" missing or not ${kind}`);
  return value as never;
}

function parse(raw: string): Result {
  if (!raw.trim()) throw new BrowserError('malformed broker response: empty');
  let response: unknown;
  try { response = JSON.parse(raw); } catch { throw new BrowserError('malformed broker response: not JSON'); }
  if (typeof response !== 'object' || response === null || typeof (response as Result).ok !== 'boolean') {
    throw new BrowserError("malformed broker response: missing 'ok'");
  }
  const { ok, error, result } = response as Result;
  if (!ok) {
    const message = typeof error === 'string' && error ? error : 'unknown broker error';
    throw blockedPrefixes.some((prefix) => message.startsWith(prefix)) ? new BrowserBlockedError(message) : new BrowserError(message);
  }
  if (typeof result !== 'object' || result === null || Array.isArray(result)) {
    throw new BrowserError("malformed broker response: 'result' is not an object");
  }
  return result as Result;
}

const page = (result: Result): BrowserPage => ({ url: field(result, 'url', 'string'), title: field(result, 'title', 'string') });

export function createBrokerBrowser(options: BrokerOptions): BrokerBrowser {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const maxResponseBytes = options.maxResponseBytes ?? 32 * 1024 * 1024;

  function request(action: string, args: Result = {}, signal?: AbortSignal): Promise<Result> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(signal.reason); return; }
      const chunks: Buffer[] = [];
      let size = 0;
      let settled = false;
      const socket = createConnection(options.socketPath);
      const finish = (error: unknown, result?: Result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        socket.destroy();
        if (error) reject(error); else resolve(result!);
      };
      const onAbort = () => finish(signal!.reason);
      const timer = setTimeout(
        () => finish(new BrowserUnavailableError(`browser broker did not answer within ${timeoutMs / 1000}s`)), timeoutMs,
      );
      signal?.addEventListener('abort', onAbort, { once: true });

      socket.on('connect', () => socket.write(`${JSON.stringify({ action, args })}\n`));
      socket.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxResponseBytes) finish(new BrowserError(`broker response larger than ${maxResponseBytes} bytes`));
        else chunks.push(chunk);
      });
      socket.on('end', () => {
        try { finish(null, parse(Buffer.concat(chunks).toString('utf8'))); } catch (error) { finish(error); }
      });
      socket.on('error', (error: NodeJS.ErrnoException) => {
        finish(error.code === 'ENOENT'
          ? new BrowserUnavailableError(`browser broker is not running (no socket ${options.socketPath})`)
          : new BrowserUnavailableError(`cannot talk to browser broker: ${error.message}`));
      });
    });
  }

  /** All allowed links of the current page, paged by the broker's maximum; one page only. */
  async function readLinks(signal?: AbortSignal): Promise<{ url: string; links: BrowserLink[] }> {
    const links: BrowserLink[] = [];
    let offset = 0;
    let url: string | undefined;
    for (let call = 0; call < maxLinkCalls; call++) {
      const result = await request('get_links', { offset, max_links: linkPage }, signal);
      const resultUrl = field(result, 'url', 'string');
      if (url !== undefined && resultUrl !== url) throw new BrowserError(`page changed while reading links (${url} -> ${resultUrl})`);
      url = resultUrl;
      for (const item of field(result, 'links', 'object') as unknown[]) {
        if (typeof item !== 'object' || item === null) throw new BrowserError('malformed broker response: link is not an object');
        links.push({ href: field(item as Result, 'href', 'string'), text: field(item as Result, 'text', 'string') });
      }
      const end = field(result, 'end', 'number');
      if (end >= field(result, 'total', 'number') || end <= offset) return { url, links };
      offset = end;
    }
    throw new BrowserError(`page links did not end after ${maxLinkCalls} calls`);
  }

  return {
    async ping(signal) {
      const result = await request('ping', {}, signal);
      return {
        connected: field(result, 'connected', 'boolean'),
        chromium: field(result, 'chromium', 'string'),
        allowList: field(result, 'allow_list', 'string'),
      };
    },

    async open(url, signal) {
      const result = await request('open', { url }, signal);
      const status = result.status;
      return { ...page(result), status: Number.isInteger(status) ? status as number : null };
    },

    async currentPage(signal) {
      const result = await request('current_page', {}, signal);
      return field(result, 'open', 'boolean') ? page(result) : null;
    },

    async text(signal) {
      const parts: string[] = [];
      let offset = 0;
      let url: string | undefined;
      for (let call = 0; call < maxTextCalls; call++) {
        const chunk = await request('get_text', { offset, max_chars: textChunk }, signal);
        const chunkUrl = field(chunk, 'url', 'string');
        if (url !== undefined && chunkUrl !== url) throw new BrowserError(`page changed while reading text (${url} -> ${chunkUrl})`);
        url = chunkUrl;
        parts.push(field(chunk, 'text', 'string'));
        const end = field(chunk, 'end', 'number');
        if (end >= field(chunk, 'total', 'number') || end <= offset) return { url, text: parts.join('') };
        offset = end;
      }
      throw new BrowserError(`page text did not end after ${maxTextCalls} chunks`);
    },

    async links(signal) {
      for (let restart = 0; ; restart++) {
        try {
          return await readLinks(signal);
        } catch (error) {
          if (!(error instanceof BrowserError) || !error.message.includes(linksAgain) || restart >= linkRestarts) throw error;
        }
      }
    },

    async scroll(screens, signal) {
      if (!Number.isInteger(screens) || screens < 1 || screens > 5) throw new BrowserError('scroll: screens must be 1–5');
      await request('scroll', { direction: 'down', screens }, signal);
    },
  };
}
