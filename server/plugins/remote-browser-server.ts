import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RemoteBrowserController, RemoteBrowserEnd, RemoteKey } from './remote-browser.js';

/**
 * The page of the remote browser: a small HTTP server the bot starts for one session and stops after it.
 * It listens on 127.0.0.1 only (Tailscale HTTPS proxies it). Everything lives under /s/<token> with a
 * random token (24 bytes, base64url); any other path, a wrong token or an expired session is 404.
 *
 * GET /s/<token> — the page (one self-contained HTML, no external scripts; a plain page and a Telegram Mini App);
 * GET /s/<token>/frame.jpg — the current screenshot, the page URL in `x-page-url`;
 * POST /s/<token>/action — JSON: tap {x, y} (CSS px), scroll {dy}, text {text}, key {key}, back, reload, goto {url}, resize {height}.
 *
 * Only actions count as activity (the page polls frames all the time): after `idleMs` without them, or
 * `maxMs` in all, the token stops working and `onExpire` fires once.
 */

export type RemoteBrowserServerOptions = Readonly<{
  controller: RemoteBrowserController;
  /** 0 — any free port (tests). */
  port: number;
  /** Public address of the port, without a trailing slash: the link is <publicUrl>/s/<token>. */
  publicUrl: string;
  idleMs: number;
  maxMs: number;
  onExpire(reason: RemoteBrowserEnd): void;
  now?: () => number;
  /** How often expiry is checked without requests, ms. */
  checkEveryMs?: number;
  /** Fixed token (tests); by default 24 random bytes. */
  token?: string;
}>;

export type RemoteBrowserServer = Readonly<{
  token: string;
  link: string;
  /** The port it listens on (the real one when 0 was asked). */
  port: number;
  close(): Promise<void>;
}>;

const host = '127.0.0.1';
const bodyMax = 16 * 1024;
const textMax = 2000;
const keys: readonly RemoteKey[] = ['Enter', 'Backspace', 'Tab', 'Escape'];

export type RemoteAction =
  | Readonly<{ type: 'tap'; x: number; y: number }>
  | Readonly<{ type: 'scroll'; dy: number }>
  | Readonly<{ type: 'text'; text: string }>
  | Readonly<{ type: 'key'; key: RemoteKey }>
  | Readonly<{ type: 'back' }>
  | Readonly<{ type: 'reload' }>
  | Readonly<{ type: 'goto'; url: string }>
  | Readonly<{ type: 'resize'; height: number }>;

const finite = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;

/** The action of a POST body, or a reason it is refused. */
export function parseRemoteAction(body: unknown): RemoteAction | string {
  if (typeof body !== 'object' || body === null) return 'ожидается JSON-объект';
  const data = body as Record<string, unknown>;
  switch (data.type) {
    case 'tap':
      return finite(data.x, 0, 4000) && finite(data.y, 0, 4000) ? { type: 'tap', x: data.x, y: data.y } : 'tap: x и y — числа';
    case 'scroll':
      return finite(data.dy, -20_000, 20_000) ? { type: 'scroll', dy: Math.round(data.dy) } : 'scroll: dy — число';
    case 'text':
      return typeof data.text === 'string' && data.text.length > 0 && data.text.length <= textMax
        ? { type: 'text', text: data.text } : `text: от 1 до ${textMax} символов`;
    case 'key':
      return keys.includes(data.key as RemoteKey) ? { type: 'key', key: data.key as RemoteKey } : `key: ${keys.join(', ')}`;
    case 'back':
    case 'reload':
      return { type: data.type };
    case 'goto': {
      if (typeof data.url !== 'string') return 'goto: url';
      let url: URL;
      try { url = new URL(data.url); } catch { return 'goto: не URL'; }
      return ['http:', 'https:'].includes(url.protocol) ? { type: 'goto', url: url.toString() } : 'goto: только http(s)';
    }
    case 'resize':
      return finite(data.height, 300, 2000) ? { type: 'resize', height: Math.round(data.height) } : 'resize: height от 300 до 2000';
    default:
      return 'неизвестное действие';
  }
}

function perform(controller: RemoteBrowserController, action: RemoteAction): Promise<void> {
  switch (action.type) {
    case 'tap': return controller.tap(action.x, action.y);
    case 'scroll': return controller.scroll(action.dy);
    case 'text': return controller.insertText(action.text);
    case 'key': return controller.press(action.key);
    case 'back': return controller.back();
    case 'reload': return controller.reload();
    case 'goto': return controller.goto(action.url);
    case 'resize': return controller.resize(action.height);
  }
}

function sameToken(given: string, token: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

const securityHeaders = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
} as const;

function send(response: ServerResponse, status: number, type: string, body: string | Buffer, headers: Record<string, string> = {}): void {
  response.writeHead(status, { ...securityHeaders, 'content-type': type, 'content-length': String(Buffer.byteLength(body)), ...headers });
  response.end(body);
}

const notFound = (response: ServerResponse) => send(response, 404, 'text/plain; charset=utf-8', 'Not found');
const json = (response: ServerResponse, status: number, data: object) => send(response, status, 'application/json; charset=utf-8', JSON.stringify(data));

async function readBody(request: IncomingMessage): Promise<string | null> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > bodyMax) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 300);

export async function startRemoteBrowserServer(options: RemoteBrowserServerOptions): Promise<RemoteBrowserServer> {
  const now = options.now ?? Date.now;
  const token = options.token ?? randomBytes(24).toString('base64url');
  const base = `/s/${token}`;
  const startedAt = now();
  let lastActivity = startedAt;
  let ended: RemoteBrowserEnd | null = null;

  /** Ends the session once: the token stops working and the owner is told. */
  const expired = (): boolean => {
    if (ended) return true;
    const time = now();
    const reason = time - startedAt >= options.maxMs ? 'max' : time - lastActivity >= options.idleMs ? 'idle' : null;
    if (!reason) return false;
    ended = reason;
    try { options.onExpire(reason); } catch { /* the owner's handler must not break the server */ }
    return true;
  };

  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      if (!response.headersSent) json(response, 500, { ok: false, error: errorText(error) });
      else response.destroy();
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = (request.url ?? '/').split('?')[0]!;
    const match = path.match(/^\/s\/([A-Za-z0-9_-]{1,64})(\/[\w.-]*)?$/);
    if (!match || !sameToken(match[1]!, token) || expired()) { notFound(response); return; }
    const rest = match[2] ?? '';

    if (request.method === 'GET' && (rest === '' || rest === '/')) {
      lastActivity = now();
      send(response, 200, 'text/html; charset=utf-8', remoteBrowserPage(base), {
        'content-security-policy': "default-src 'none'; img-src 'self' blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; "
          + "connect-src 'self'; base-uri 'none'; form-action 'none'",
      });
      return;
    }
    if (request.method === 'GET' && rest === '/frame.jpg') {
      try {
        const frame = await options.controller.frame();
        send(response, 200, 'image/jpeg', frame.jpeg, { 'x-page-url': encodeURIComponent(frame.url) });
      } catch (error) {
        json(response, 502, { ok: false, error: errorText(error) });
      }
      return;
    }
    if (request.method === 'POST' && rest === '/action') {
      const body = await readBody(request);
      if (body === null) { json(response, 413, { ok: false, error: 'слишком большой запрос' }); return; }
      let data: unknown;
      try { data = JSON.parse(body); } catch { json(response, 400, { ok: false, error: 'не JSON' }); return; }
      const action = parseRemoteAction(data);
      if (typeof action === 'string') { json(response, 400, { ok: false, error: action }); return; }
      lastActivity = now();
      try {
        await perform(options.controller, action);
        json(response, 200, { ok: true });
      } catch (error) {
        json(response, 502, { ok: false, error: errorText(error) });
      }
      return;
    }
    notFound(response);
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      reject(new Error(error.code === 'EADDRINUSE' ? `порт ${options.port} занят (REMOTE_BROWSER_PORT)` : error.message));
    });
    server.listen(options.port, host, () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : options.port;
  const check = setInterval(() => { expired(); }, options.checkEveryMs ?? 30_000);
  check.unref();

  let closing: Promise<void> | null = null;
  return {
    token,
    link: `${options.publicUrl.replace(/\/+$/, '')}${base}`,
    port,
    close: () => (closing ??= new Promise<void>((resolve) => {
      clearInterval(check);
      ended ??= 'idle';
      server.close(() => resolve());
      server.closeAllConnections();
    })),
  };
}

// ── The page ──

/**
 * One mobile page: the screenshot fills the width (the viewport height follows the phone's screen shape),
 * a tap is sent in CSS pixels, a swipe or the wheel scrolls, the text field types into the focused element,
 * buttons ⌫ ↵ Tab ← Назад ⟳. A new frame follows every action and comes every 1.5 s anyway.
 */
export function remoteBrowserPage(base: string): string {
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<meta name="referrer" content="no-referrer">
<title>Браузер агента</title>
<style>
:root { color-scheme: light dark; --bg: #f2f2f5; --fg: #15161a; --muted: #6b6c73; --bar: #ffffff; --line: #d4d4da; --accent: #2481cc; }
@media (prefers-color-scheme: dark) { :root { --bg: #111214; --fg: #ececf0; --muted: #9a9aa3; --bar: #1c1d21; --line: #34353b; --accent: #4c9be8; } }
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; background: var(--bg); color: var(--fg); font: 15px/1.3 -apple-system, system-ui, sans-serif; }
body { display: flex; flex-direction: column; height: 100dvh; overflow: hidden; }
header { display: flex; gap: 8px; align-items: center; padding: 6px 10px; background: var(--bar); border-bottom: 1px solid var(--line); }
#url { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); font-size: 13px; }
#state { font-size: 12px; color: var(--muted); white-space: nowrap; }
main { flex: 1; min-height: 0; display: flex; justify-content: center; align-items: flex-start; overflow: hidden; }
#screen { display: block; max-width: 100%; max-height: 100%; touch-action: none; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; }
footer { background: var(--bar); border-top: 1px solid var(--line); padding: 8px 10px calc(8px + env(safe-area-inset-bottom)); display: grid; gap: 8px; }
form, .keys { display: flex; gap: 6px; }
input { flex: 1; min-width: 0; font-size: 16px; padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: var(--fg); }
button { font: inherit; padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: var(--fg); min-height: 40px; }
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.keys button { flex: 1; padding: 8px 4px; }
#closed { display: none; padding: 32px 16px; text-align: center; color: var(--muted); }
body.closed main, body.closed footer { display: none; }
body.closed #closed { display: block; }
</style>
</head>
<body>
<header><div id="url">…</div><div id="state"></div></header>
<main><img id="screen" alt="Экран браузера"></main>
<footer>
  <form id="type"><input id="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Текст в выбранное поле"><button class="primary">Отправить</button></form>
  <div class="keys">
    <button data-key="Backspace" aria-label="Стереть">⌫</button>
    <button data-key="Enter" aria-label="Enter">↵</button>
    <button data-key="Tab">Tab</button>
    <button id="back">← Назад</button>
    <button id="reload" aria-label="Обновить страницу">⟳</button>
  </div>
</footer>
<div id="closed">Сессия браузера закрыта. Вернитесь в Telegram.</div>
<script>
(() => {
  const base = ${JSON.stringify(base)};
  const width = 390;
  const screen = document.getElementById('screen');
  const urlLine = document.getElementById('url');
  const stateLine = document.getElementById('state');
  let closed = false;
  let pending = 0;
  let loading = null;
  let shown = null;
  let lastHeight = 0;

  try { window.Telegram && window.Telegram.WebApp && (window.Telegram.WebApp.ready(), window.Telegram.WebApp.expand()); } catch (error) {}

  const state = (text) => { stateLine.textContent = text; };
  const end = () => { closed = true; document.body.classList.add('closed'); };

  function frame() {
    if (closed) return Promise.resolve();
    if (loading) return loading;
    loading = (async () => {
      try {
        const response = await fetch(base + '/frame.jpg?t=' + Date.now(), { cache: 'no-store' });
        if (response.status === 404) { end(); return; }
        if (!response.ok) { state('нет кадра'); return; }
        const url = response.headers.get('x-page-url');
        if (url) urlLine.textContent = decodeURIComponent(url);
        const next = URL.createObjectURL(await response.blob());
        await new Promise((resolve) => { screen.onload = resolve; screen.onerror = resolve; screen.src = next; });
        if (shown) URL.revokeObjectURL(shown);
        shown = next;
        if (!pending) state('');
      } catch (error) {
        state('нет связи');
      } finally {
        loading = null;
      }
    })();
    return loading;
  }

  async function act(action) {
    if (closed) return;
    pending++;
    state('…');
    try {
      const response = await fetch(base + '/action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(action) });
      if (response.status === 404) { end(); return; }
      const result = await response.json().catch(() => ({}));
      state(result.ok ? '' : 'ошибка: ' + (result.error || response.status));
    } catch (error) {
      state('нет связи');
    } finally {
      pending--;
    }
    await frame();
    setTimeout(frame, 800);
  }

  // Tap or swipe on the screenshot: coordinates in CSS pixels of the remote page (width 390).
  let start = null;
  screen.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    start = { x: event.clientX, y: event.clientY };
    try { screen.setPointerCapture(event.pointerId); } catch (error) {}
  });
  screen.addEventListener('pointerup', (event) => {
    if (!start) return;
    const from = start;
    start = null;
    const box = screen.getBoundingClientRect();
    if (!box.width) return;
    const scale = width / box.width;
    const dx = event.clientX - from.x;
    const dy = event.clientY - from.y;
    if (Math.hypot(dx, dy) < 10) act({ type: 'tap', x: Math.round((from.x - box.left) * scale), y: Math.round((from.y - box.top) * scale) });
    else act({ type: 'scroll', dy: Math.round(-dy * scale * 1.5) });
  });
  screen.addEventListener('pointercancel', () => { start = null; });
  screen.addEventListener('contextmenu', (event) => event.preventDefault());
  screen.addEventListener('wheel', (event) => { event.preventDefault(); act({ type: 'scroll', dy: Math.round(event.deltaY) }); }, { passive: false });

  document.getElementById('type').addEventListener('submit', (event) => {
    event.preventDefault();
    const input = document.getElementById('text');
    if (!input.value) return;
    const text = input.value;
    input.value = '';
    act({ type: 'text', text });
  });
  for (const button of document.querySelectorAll('[data-key]')) {
    button.addEventListener('click', () => act({ type: 'key', key: button.dataset.key }));
  }
  document.getElementById('back').addEventListener('click', () => act({ type: 'back' }));
  document.getElementById('reload').addEventListener('click', () => act({ type: 'reload' }));

  // The remote viewport takes the shape of the free area, so the screenshot fills the width without scrolling.
  function fit() {
    const area = document.querySelector('main');
    if (!area.clientWidth || !area.clientHeight) return;
    const height = Math.round(Math.min(1400, Math.max(480, width * area.clientHeight / area.clientWidth)));
    if (Math.abs(height - lastHeight) < 8) return;
    lastHeight = height;
    act({ type: 'resize', height });
  }
  let fitTimer = null;
  window.addEventListener('resize', () => { clearTimeout(fitTimer); fitTimer = setTimeout(fit, 300); });

  fit();
  frame();
  setInterval(() => { if (!document.hidden && !pending) frame(); }, 1500);
})();
</script>
</body>
</html>
`;
}
