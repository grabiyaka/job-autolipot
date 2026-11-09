/**
 * Minimal MCP client over streamable HTTP on fetch: initialize → notifications/initialized → tools/call,
 * with the Mcp-Session-Id header; a response is either JSON or an SSE stream with the JSON-RPC answer.
 * Enough to drive Playwright MCP (the remote browser); no SDK dependency.
 */

export type McpContent = Readonly<{ type: string; text?: string; data?: string; mimeType?: string }>;
export type McpToolResult = Readonly<{ content: McpContent[]; isError?: boolean }>;

export class McpError extends Error {
  override name = 'McpError';
}

export type McpClientConfig = Readonly<{
  /** Playwright MCP endpoint, e.g. http://127.0.0.1:8931/mcp. */
  url: string;
  /** Timeout of one request, ms. */
  timeoutMs?: number;
  clientName?: string;
}>;

export interface McpClient {
  callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult>;
  /** Ends the MCP session (DELETE); safe to call twice. */
  close(): Promise<void>;
}

type JsonRpcResponse = { id?: number; result?: unknown; error?: { code: number; message: string } };

/** The JSON-RPC answer with this id from a JSON body or an SSE stream (`data:` lines of each event). */
export function parseRpcBody(body: string, contentType: string | null, id: number): JsonRpcResponse | null {
  const messages: unknown[] = [];
  if (contentType?.includes('text/event-stream')) {
    for (const event of body.split(/\r?\n\r?\n/)) {
      const data = event.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
      if (!data) continue;
      try { messages.push(JSON.parse(data)); } catch { /* not JSON: skip the event */ }
    }
  } else if (body.trim()) {
    const parsed: unknown = JSON.parse(body);
    messages.push(...(Array.isArray(parsed) ? parsed : [parsed]));
  }
  const found = messages.find((message) => typeof message === 'object' && message !== null && (message as JsonRpcResponse).id === id);
  return (found as JsonRpcResponse | undefined) ?? null;
}

export async function connectMcp(config: McpClientConfig): Promise<McpClient> {
  const timeoutMs = config.timeoutMs ?? 60_000;
  let sessionId: string | null = null;
  let nextId = 0;
  let closed = false;

  async function post(body: object): Promise<Response> {
    const response = await fetch(config.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json', accept: 'application/json, text/event-stream',
        ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    sessionId = response.headers.get('mcp-session-id') ?? sessionId;
    return response;
  }

  async function request(method: string, params: object): Promise<unknown> {
    const id = ++nextId;
    let response: Response;
    try {
      response = await post({ jsonrpc: '2.0', id, method, params });
    } catch (error) {
      const timeout = error instanceof Error && error.name === 'TimeoutError';
      throw new McpError(`Playwright MCP ${method}: ${timeout ? 'таймаут' : `недоступен (${error instanceof Error ? error.message : error})`}`);
    }
    const text = await response.text();
    if (!response.ok) throw new McpError(`Playwright MCP ${method}: HTTP ${response.status} ${text.slice(0, 200)}`);
    const answer = parseRpcBody(text, response.headers.get('content-type'), id);
    if (!answer) throw new McpError(`Playwright MCP ${method}: нет ответа`);
    if (answer.error) throw new McpError(`Playwright MCP ${method}: ${answer.error.message}`);
    return answer.result;
  }

  await request('initialize', {
    protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: config.clientName ?? 'job-autopilot', version: '1' },
  });
  const initialized = await post({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
  await initialized.text();

  return {
    async callTool(name, args) {
      if (closed) throw new McpError('MCP-сессия закрыта');
      const result = await request('tools/call', { name, arguments: args }) as McpToolResult | undefined;
      return { content: Array.isArray(result?.content) ? result.content : [], ...(result?.isError ? { isError: true } : {}) };
    },
    async close() {
      if (closed) return;
      closed = true;
      if (!sessionId) return;
      await fetch(config.url, { method: 'DELETE', headers: { 'mcp-session-id': sessionId }, signal: AbortSignal.timeout(5_000) })
        .then((response) => response.text())
        .catch(() => undefined);
    },
  };
}
