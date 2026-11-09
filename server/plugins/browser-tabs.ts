import { connectMcp, McpError } from './mcp-client.js';
import type { McpClient } from './mcp-client.js';

/**
 * Tabs of the shared agent Chromium as CDP targets, through Playwright MCP: their ids do not change when an
 * MCP session drops and tab indices shift, so the collector can close exactly the tabs its agent opened.
 * Each call is a short MCP session of its own; reading the targets opens no tab.
 */

export type BrowserTab = Readonly<{ id: string; url: string }>;

export type BrowserTabs = Readonly<{
  list(): Promise<BrowserTab[]>;
  close(ids: readonly string[]): Promise<void>;
}>;

const listCode = `async (page) => {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { targetInfos } = await cdp.send('Target.getTargets');
    return targetInfos.filter((target) => target.type === 'page').map((target) => ({ id: target.targetId, url: target.url }));
  } finally { await cdp.detach().catch(() => {}); }
}`;

const closeCode = (ids: readonly string[]) => `async (page) => {
  const ids = ${JSON.stringify(ids)};
  const cdp = await page.context().newCDPSession(page);
  try { for (const targetId of ids) await cdp.send('Target.closeTarget', { targetId }).catch(() => {}); }
  finally { await cdp.detach().catch(() => {}); }
}`;

/** The JSON after «### Result» of browser_run_code_unsafe. */
function resultJson(text: string): unknown {
  const match = text.match(/### Result\s*\n([\s\S]*?)(?:\n###\s|$)/);
  const raw = match?.[1]?.trim() ?? '';
  try { return JSON.parse(raw); } catch { throw new McpError(`браузер: непонятный список вкладок: ${raw.slice(0, 200)}`); }
}

export function parseTabs(text: string): BrowserTab[] {
  const data = resultJson(text);
  if (!Array.isArray(data)) throw new McpError('браузер: список вкладок — не массив');
  return data.flatMap((item) => {
    const { id, url } = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>;
    return typeof id === 'string' && typeof url === 'string' ? [{ id, url }] : [];
  });
}

export function mcpBrowserTabs(mcpUrl: string, connect: typeof connectMcp = connectMcp): BrowserTabs {
  async function session<T>(work: (client: McpClient) => Promise<T>): Promise<T> {
    const client = await connect({ url: mcpUrl, timeoutMs: 30_000, clientName: 'job-autopilot-hunt-tabs' });
    try { return await work(client); } finally { await client.close(); }
  }
  async function run(client: McpClient, code: string): Promise<string> {
    const result = await client.callTool('browser_run_code_unsafe', { code });
    const text = result.content.map((item) => item.text ?? '').join('\n');
    if (result.isError) throw new McpError(`браузер: ${text.slice(0, 300) || 'ошибка'}`);
    return text;
  }
  return {
    list: () => session(async (client) => parseTabs(await run(client, listCode))),
    close: async (ids) => {
      if (!ids.length) return;
      await session(async (client) => { await run(client, closeCode(ids)); });
    },
  };
}
