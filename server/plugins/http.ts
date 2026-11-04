import type { HttpClient } from '../src/searches/SearchTypes.js';

export type HttpOptions = Readonly<{
  userAgent: string;
  timeoutMs: number;
  /** Extra attempts after a network error, 429 or 5xx. */
  retries: number;
  pause(ms: number, signal: AbortSignal): Promise<void>;
}>;

export class HttpError extends Error {
  constructor(readonly status: number, url: string) {
    super(`HTTP ${status} для ${url}`);
  }
}

const retriable = (status: number) => status === 429 || status >= 500;

/**
 * fetch with a per-request timeout, a stable User-Agent and a few retries with growing pauses.
 * Resolves with the whole response (headers included) when it is 2xx; any other status is an HttpError.
 */
export function createHttpRequest(options: HttpOptions): (url: string, init?: RequestInit) => Promise<Response> {
  return async function request(url: string, init: RequestInit = {}): Promise<Response> {
    const runSignal = init.signal ?? new AbortController().signal;
    for (let attempt = 0; ; attempt++) {
      const signal = AbortSignal.any([runSignal, AbortSignal.timeout(options.timeoutMs)]);
      try {
        const response = await fetch(url, {
          ...init, signal, headers: { 'user-agent': options.userAgent, ...init.headers },
        });
        if (response.ok) return response;
        if (!retriable(response.status) || attempt >= options.retries) throw new HttpError(response.status, url);
      } catch (error) {
        if (runSignal.aborted || error instanceof HttpError || attempt >= options.retries) throw error;
      }
      await options.pause(1000 * 2 ** attempt, runSignal);
    }
  };
}

/** Text and JSON over createHttpRequest. */
export function createHttpClient(options: HttpOptions): HttpClient {
  const request = createHttpRequest(options);
  return {
    text: async (url, init) => (await request(url, init)).text(),
    json: async <T>(url: string, init?: RequestInit) => await (await request(url, init)).json() as T,
  };
}

/** setTimeout that rejects as soon as the signal aborts. */
export function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    function onAbort() { clearTimeout(timer); reject(signal.reason); }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
