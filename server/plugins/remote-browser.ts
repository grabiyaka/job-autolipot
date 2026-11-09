import { connectMcp, McpError } from './mcp-client.js';
import type { McpClient, McpToolResult } from './mcp-client.js';
import { startRemoteBrowserServer } from './remote-browser-server.js';

/**
 * The remote browser: the owner works in the agent's own Chromium from a phone (Telegram) — creates an
 * account or signs in on a site the agent could not get past, so the agent continues there logged in.
 *
 * The agent Chromium is reachable only through Playwright MCP (attached to it over CDP, so the pages and
 * cookies are the agent's). The controller drives one tab of it with `browser_run_code_unsafe`: phone
 * emulation through a CDP session of the tab (390×844, DPR 2, touch), screenshots with
 * Page.captureScreenshot (Playwright's own screenshot resets the emulated DPR), taps, scrolling and typing.
 * Every call goes through one queue, so a screenshot never races an action. `close` resets the emulation
 * and closes the tabs it opened: the browser is left as it was found.
 */

export type RemoteViewport = Readonly<{ width: number; height: number; deviceScaleFactor: number }>;
export const defaultRemoteViewport: RemoteViewport = { width: 390, height: 844, deviceScaleFactor: 2 };

/** Keys the page may press; anything else is refused. */
export const remoteKeys = ['Enter', 'Backspace', 'Tab', 'Escape'] as const;
export type RemoteKey = typeof remoteKeys[number];

export type RemoteFrame = Readonly<{ jpeg: Buffer; url: string }>;

export interface RemoteBrowserController {
  /** Opens `url` in a new tab with phone emulation. */
  open(url: string): Promise<void>;
  /** A JPEG of the visible part of the page and the page's URL. */
  frame(): Promise<RemoteFrame>;
  /** A tap at CSS pixels of the emulated viewport. */
  tap(x: number, y: number): Promise<void>;
  /** Scrolls by `dy` CSS pixels (positive — down). */
  scroll(dy: number): Promise<void>;
  /** Types text into the focused element. */
  insertText(text: string): Promise<void>;
  press(key: RemoteKey): Promise<void>;
  back(): Promise<void>;
  reload(): Promise<void>;
  goto(url: string): Promise<void>;
  /** A new viewport height (the phone's screen shape); the width stays. */
  resize(height: number): Promise<void>;
  currentUrl(): Promise<string>;
  /** Resets the emulation, closes the opened tabs and the MCP session; safe to call twice. */
  close(): Promise<void>;
}

export type McpRemoteBrowserConfig = Readonly<{
  /** Playwright MCP (PLAYWRIGHT_MCP_URL). */
  mcpUrl: string;
  viewport?: RemoteViewport;
  /** Timeout of one MCP call, ms. */
  timeoutMs?: number;
}>;

/** The JSON a `browser_run_code_unsafe` call returned: Playwright MCP prints it under «### Result». */
export function runCodeResult(result: McpToolResult): unknown {
  const text = result.content.filter((item) => item.type === 'text').map((item) => item.text ?? '').join('\n');
  if (result.isError || /^### Error/m.test(text)) {
    const error = text.replace(/^### Error\s*/m, '').split('\n### ')[0]!.trim();
    throw new McpError(`браузер: ${error.slice(0, 300) || 'ошибка'}`);
  }
  const match = text.match(/### Result\s*\n([\s\S]*?)(?:\n###\s|$)/);
  const raw = match?.[1]?.trim() ?? '';
  if (!raw || raw === 'undefined') return undefined;
  try { return JSON.parse(raw); } catch { return raw; }
}

/**
 * Code shared by every snippet. `target()` is the newest open tab this controller opened (a popup the site
 * opened from it counts too), else the current tab; `emulated(p)` attaches the CDP session with the phone
 * emulation once per tab and keeps it on the page object (snippets do not share globals).
 */
function prelude(viewport: RemoteViewport, height: number): string {
  const metrics = JSON.stringify({ width: viewport.width, height, deviceScaleFactor: viewport.deviceScaleFactor, mobile: true });
  return `
  const ours = () => page.context().pages().filter((p) => p.__remoteBrowser && !p.isClosed());
  const target = () => ours().at(-1) ?? page;
  const emulated = async (p) => {
    const metrics = ${metrics};
    if (!p.__remoteBrowserCdp || p.__remoteBrowserHeight !== metrics.height) {
      const cdp = p.__remoteBrowserCdp ?? await p.context().newCDPSession(p);
      await cdp.send('Emulation.setDeviceMetricsOverride', metrics);
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
      p.__remoteBrowserCdp = cdp;
      p.__remoteBrowserHeight = metrics.height;
    }
    return p.__remoteBrowserCdp;
  };
  const mark = (p) => {
    p.__remoteBrowser = true;
    p.on('popup', (popup) => { mark(popup); });
  };
  const settle = (p) => p.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});`;
}

export function createMcpRemoteBrowser(config: McpRemoteBrowserConfig): RemoteBrowserController {
  const viewport = config.viewport ?? defaultRemoteViewport;
  let height = viewport.height;
  let client: McpClient | null = null;
  let opened = false;
  let closed = false;
  // One call at a time: a screenshot waits for the action before it.
  let queue: Promise<unknown> = Promise.resolve();

  function serial<T>(work: () => Promise<T>): Promise<T> {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  }

  async function run(body: string, args: Record<string, unknown> = {}): Promise<unknown> {
    if (!client) throw new McpError('браузер не открыт');
    // Arguments go in as a JSON literal: text the owner types cannot break out of the snippet.
    const code = `async (page) => {${prelude(viewport, height)}
  const args = ${JSON.stringify(args)};
  ${body}
}`;
    return runCodeResult(await client.callTool('browser_run_code_unsafe', { code }));
  }

  const act = (body: string, args: Record<string, unknown> = {}) => serial(async () => { await run(body, args); });

  return {
    open: (url) => serial(async () => {
      if (closed) throw new McpError('браузер закрыт');
      client ??= await connectMcp({ url: config.mcpUrl, timeoutMs: config.timeoutMs ?? 60_000, clientName: 'job-autopilot-remote-browser' });
      const tab = await client.callTool('browser_tabs', { action: 'new' });
      if (tab.isError) throw new McpError('браузер: не удалось открыть вкладку');
      opened = true;
      // Emulation first, so the site lays out for a phone from the first paint; a slow site still shows what loaded.
      await run(`const p = page; mark(p); await emulated(p);
  await p.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});`, { url });
    }),

    frame: () => serial(async () => {
      const shot = await run(`const p = target(); const cdp = await emulated(p);
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 60 });
  return { data, url: p.url() };`) as { data?: unknown; url?: unknown } | undefined;
      if (typeof shot?.data !== 'string') throw new McpError('браузер: нет снимка экрана');
      return { jpeg: Buffer.from(shot.data, 'base64'), url: typeof shot.url === 'string' ? shot.url : '' };
    }),

    tap: (x, y) => act(`const p = target(); await emulated(p);
  await p.mouse.click(args.x, args.y); await p.waitForTimeout(300); await settle(p);`, { x, y }),

    scroll: (dy) => act(`const p = target(); await emulated(p);
  await p.mouse.move(args.x, args.y); await p.mouse.wheel(0, args.dy); await p.waitForTimeout(250);`,
    { dy, x: Math.round(viewport.width / 2), y: Math.round(height / 2) }),

    insertText: (text) => act(`const p = target(); await emulated(p); await p.keyboard.insertText(args.text);`, { text }),

    press: (key) => act(`const p = target(); await emulated(p); await p.keyboard.press(args.key); await p.waitForTimeout(200); await settle(p);`, { key }),

    back: () => act(`const p = target(); await emulated(p); await p.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});`),

    reload: () => act(`const p = target(); await emulated(p); await p.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});`),

    goto: (url) => act(`const p = target(); await emulated(p); await p.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});`, { url }),

    resize: (next) => serial(async () => {
      height = Math.round(next);
      await run(`for (const p of ours()) await emulated(p);`);
    }),

    currentUrl: () => serial(async () => {
      const url = await run(`return target().url();`);
      return typeof url === 'string' ? url : '';
    }),

    close: () => serial(async () => {
      if (closed) return;
      closed = true;
      if (!client) return;
      try {
        if (opened) {
          await run(`for (const p of ours()) {
    const cdp = p.__remoteBrowserCdp;
    if (cdp) {
      await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => {});
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false }).catch(() => {});
      await cdp.detach().catch(() => {});
    }
    await p.close().catch(() => {});
  }`);
        }
      } finally {
        await client.close();
      }
    }),
  };
}

// ── Session: the controller plus its page ──

export type RemoteBrowserSettings = Readonly<{
  mcpUrl: string;
  /** Local port of the page (REMOTE_BROWSER_PORT); it listens on 127.0.0.1 only. */
  port: number;
  /** Public address of that port (REMOTE_BROWSER_PUBLIC_URL), e.g. Tailscale HTTPS. */
  publicUrl: string;
  idleMs?: number;
  maxMs?: number;
}>;

export type RemoteBrowserEnd = 'idle' | 'max';

export type RemoteBrowserSession = Readonly<{
  /** The secret page: <publicUrl>/s/<token>. */
  link: string;
  /** Stops the page and closes the browser tab (emulation reset); safe to call twice. */
  close(): Promise<void>;
}>;

/** What the bot needs: open a page for a URL; `onExpire` fires once after 30 min without actions or 60 min in all. */
export type RemoteBrowserPort = Readonly<{
  open(url: string, onExpire: (reason: RemoteBrowserEnd) => void): Promise<RemoteBrowserSession>;
}>;

export const defaultIdleMs = 30 * 60_000;
export const defaultMaxMs = 60 * 60_000;

/** The remote browser on Playwright MCP; `controller` replaces it in tests. */
export function remoteBrowser(
  settings: RemoteBrowserSettings,
  controller: () => RemoteBrowserController = () => createMcpRemoteBrowser({ mcpUrl: settings.mcpUrl }),
): RemoteBrowserPort {
  return {
    async open(url, onExpire) {
      const browser = controller();
      const server = await startRemoteBrowserServer({
        controller: browser, port: settings.port, publicUrl: settings.publicUrl,
        idleMs: settings.idleMs ?? defaultIdleMs, maxMs: settings.maxMs ?? defaultMaxMs, onExpire,
      });
      const close = async () => {
        await server.close();
        await browser.close();
      };
      try {
        await browser.open(url);
      } catch (error) {
        await close().catch(() => undefined);
        throw error;
      }
      let closing: Promise<void> | null = null;
      return { link: server.link, close: () => (closing ??= close()) };
    },
  };
}
