/**
 * What the page really calls each element: role and accessible name per `ref`, read from the
 * ARIA snapshots that Playwright MCP returns (browser_snapshot, browser_find…). The guard judges a
 * click by this, not by the `element` text that the agent writes itself. Pure: the hook reads and
 * writes refs.json, this parses and merges.
 *
 * Snapshot lines look like (YAML list, two spaces per level):
 *   - button "Submit application" [ref=f11e1300] [cursor=pointer]
 *   - paragraph [ref=f11e1228]: PDF
 *   - 'link "Foo: bar" [ref=e5]'
 * An element without a name also gets the text of its descendants, so `button [ref=x]:` with
 * `- generic: Submit` inside is still recognized.
 */

export type RefInfo = Readonly<{ role: string; name: string; text: string }>;
export type RefIndex = Readonly<{
  /** origin + path of the page the refs belong to; refs restart on another page. */
  page: string | null;
  refs: Readonly<Record<string, RefInfo>>;
}>;
export const emptyRefIndex: RefIndex = { page: null, refs: {} };

/** Descendant text kept per element; enough to see a button label. */
const maxText = 300;

const linePattern = /^(\s*)- (.*)$/;
const elementPattern = /^([a-z][\w-]*)(?: "((?:[^"\\]|\\.)*)")?((?: \[[^\]]*\])*)(?::\s?(.*))?$/i;
const refPattern = /\[ref=([^\]\s]+)\]/;

/** Unwraps a YAML single- or double-quoted list item. */
function unquote(value: string): string {
  const trimmed = value.trimEnd();
  const colon = trimmed.endsWith(':') ? ':' : '';
  const body = colon ? trimmed.slice(0, -1) : trimmed;
  if (body.length >= 2 && body.startsWith("'") && body.endsWith("'")) return body.slice(1, -1).replaceAll("''", "'") + colon;
  if (body.length >= 2 && body.startsWith('"') && body.endsWith('"')) {
    try { return (JSON.parse(body) as string) + colon; } catch { return trimmed; }
  }
  return trimmed;
}

const unescape = (value: string) => value.replace(/\\(.)/g, '$1');

/** Visible words of one line: its quoted name and its text after ":". */
function lineWords(content: string): string {
  if (content.startsWith('/')) return ''; // properties such as "/url: …"
  const match = elementPattern.exec(content);
  if (!match) return content.replace(/^text:\s*/, '');
  return [match[2] ? unescape(match[2]) : '', match[4] ?? ''].filter(Boolean).join(' ');
}

export function parseSnapshotRefs(snapshot: string): Record<string, RefInfo> {
  const lines = snapshot.split('\n').flatMap((raw) => {
    const match = linePattern.exec(raw);
    return match ? [{ indent: match[1]!.length, content: unquote(match[2]!) }] : [];
  });
  const refs: Record<string, RefInfo> = {};
  lines.forEach((line, index) => {
    const element = elementPattern.exec(line.content);
    const ref = refPattern.exec(line.content)?.[1];
    if (!element || !ref) return;
    const name = element[2] ? unescape(element[2]) : '';
    const words: string[] = [];
    let length = 0;
    for (let next = index + 1; next < lines.length && lines[next]!.indent > line.indent && length < maxText; next++) {
      const text = lineWords(lines[next]!.content).trim();
      if (text) { words.push(text); length += text.length + 1; }
    }
    const inline = element[4]?.trim() ?? '';
    refs[ref] = { role: element[1]!.toLowerCase(), name, text: [inline, ...words].filter(Boolean).join(' ').slice(0, maxText) };
  });
  return refs;
}

/** All text of an MCP tool response: a string, content blocks [{type, text}], or nested objects. */
export function responseText(response: unknown, depth = 0): string {
  if (depth > 5 || response === null || response === undefined) return '';
  if (typeof response === 'string') return response;
  if (Array.isArray(response)) return response.map((item) => responseText(item, depth + 1)).filter(Boolean).join('\n');
  if (typeof response === 'object') {
    const record = response as Record<string, unknown>;
    if (typeof record.text === 'string') return record.text;
    // Skip block metadata and binary data (type, mimeType, base64 images).
    return Object.entries(record).filter(([key]) => !['type', 'mimeType', 'data'].includes(key))
      .map(([, value]) => responseText(value, depth + 1)).filter(Boolean).join('\n');
  }
  return '';
}

/** origin + path from the "- Page URL: …" line of a response, or null. */
export function responsePage(text: string): string | null {
  const url = /^- Page URL: (\S+)/m.exec(text)?.[1];
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch { return null; }
}

/** Tools after which old refs no longer apply: a new document or another tab. */
const resetTools = new Set(['browser_navigate', 'browser_tabs', 'browser_navigate_back']);

/**
 * Index after one tool response: refs of another page are dropped, then the refs of this response
 * are added; for a ref seen again the latest value wins.
 */
export function updateRefIndex(index: RefIndex, tool: string, response: unknown): RefIndex {
  const text = responseText(response);
  const page = responsePage(text);
  const reset = resetTools.has(tool.replace(/^mcp__playwright__/, '')) || (page !== null && index.page !== null && page !== index.page);
  const base = reset ? {} : index.refs;
  return { page: page ?? index.page, refs: { ...base, ...parseSnapshotRefs(text) } };
}
