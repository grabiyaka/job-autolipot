import path from 'node:path';
import type { RefInfo } from './agent-snapshot-refs.js';

/**
 * Hard rules of the browser agent, checked by the PreToolUse hook (scripts/agent-guard.ts) before
 * every tool call; the prompt asks for the same, but only this is binding. Pure: the hook reads
 * the call and the state, this decides, the hook writes the state back.
 *
 * - fill: never submit — no click on a submit/send button, no Enter, no `submit: true`.
 * - submit: the same, except one click on such a button per run.
 * - both: only https *.linkedin.com, uploads only from <agentCwd>/files/, only the tools listed below
 *   (Playwright plus the harmless built-ins StructuredOutput and ToolSearch).
 * A false denial is cheaper than a false submission, so "submit" matches any button with that word.
 *
 * Clicks, typing and selects are judged by the element's real role and name from the page's ARIA
 * snapshot (refs.json, collected by the PostToolUse hook), not by the `element` text the agent writes:
 * a Submit button called "Primary button" by the agent is still Submit. A ref the guard has not seen
 * in a snapshot is denied. The agent's own text is checked too; either match denies.
 */

export const applyModes = ['fill', 'submit'] as const;
export type ApplyMode = typeof applyModes[number];

const playwright = 'mcp__playwright__';
/**
 * Built-in tools of `claude` the agent needs and that touch nothing: StructuredOutput returns the
 * --json-schema answer, ToolSearch loads tool schemas. Their arguments are not checked.
 */
export const builtinTools = ['StructuredOutput', 'ToolSearch'];
export const allowedTools = [
  ...builtinTools,
  ...[
    'browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_fill_form', 'browser_select_option',
    'browser_file_upload', 'browser_wait_for', 'browser_take_screenshot', 'browser_tabs', 'browser_find',
  ].map((name) => `${playwright}${name}`),
];
export const disallowedTools = [
  'Bash', 'Edit', 'Write', 'NotebookEdit', 'Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'Task', 'Agent',
  ...['browser_evaluate', 'browser_run_code_unsafe', 'browser_press_key', 'browser_handle_dialog', 'browser_close']
    .map((name) => `${playwright}${name}`),
];

/**
 * Where the user keeps files for the agent (CV). Playwright MCP may not read it directly: the plugin
 * copies its files into <agentCwd>/files/, and only that copy may be uploaded.
 */
export const agentFilesDir = '/srv/agent-files/';
/** One JSON line per tool call, in the attempt's folder (APPLY_GUARD_DIR). */
export const guardLogFile = 'guard-log.jsonl';

export type GuardState = Readonly<{ submitClicks: number }>;
export const initialGuardState: GuardState = { submitClicks: 0 };

export type GuardDecision = Readonly<{
  allow: boolean;
  /** Shown to the agent on denial: it says what to do instead. */
  reason?: string;
  /** State after this call; unchanged on denial. */
  state: GuardState;
}>;

/**
 * Words of a final "send the application" button, in the languages LinkedIn shows: Submit / Send,
 * Отправить / Подать, Надіслати, Senden / Absenden, Envoyer / Soumettre, Enviar, Invia(re),
 * Verzenden / Versturen / Indienen, Wyślij.
 */
export const submitWords = /submit|send|отправ|подать|подач|надісл|absenden|envoy|soumet|enviar|invia|verzend|verstur|indienen|wyślij|wyslij/iu;

/** `dir` with exactly one trailing slash, after resolving `..`. */
export function uploadRoot(dir: string): string {
  return `${path.posix.normalize(dir).replace(/\/+$/, '')}/`;
}

export const uploadDenyReason = (uploadDir: string) =>
  `Files may be uploaded only from ${uploadRoot(uploadDir)} (copies of ${agentFilesDir}); use the exact path given in the instructions.`;

export const denyReasons = {
  notAllowed: 'This tool is not allowed in this run.',
  submitInFill: 'Submitting is forbidden in this run: stop here and report outcome ready_to_submit.',
  secondSubmit: 'Submit was already pressed once in this run: stop and report the outcome.',
  enter: 'Enter is forbidden (it may submit the form).',
  typeSubmit: 'submit: true is forbidden.',
  foreignSite: 'Only linkedin.com is allowed. If the job needs an external site, stop and report outcome external.',
  noUploadDir: 'Uploads are not configured in this run (APPLY_UPLOAD_DIR).',
  unknownRef: 'Take browser_snapshot first: unknown element ref.',
} as const;

export function parseApplyMode(value: string | undefined): ApplyMode {
  // Anything unknown gets the stricter mode.
  return value === 'submit' ? 'submit' : 'fill';
}

/** True only for https URLs on linkedin.com or its subdomains. */
export function isLinkedinUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  return url.protocol === 'https:' && /(^|\.)linkedin\.com$/.test(url.hostname.toLowerCase());
}

/** An absolute path inside `uploadDir` after resolving `..` and repeated slashes. */
export function isUploadFile(value: unknown, uploadDir: string): boolean {
  if (typeof value !== 'string' || !value.startsWith('/') || !uploadDir.startsWith('/')) return false;
  return path.posix.normalize(value).startsWith(uploadRoot(uploadDir));
}

const deny = (reason: string, state: GuardState): GuardDecision => ({ allow: false, reason, state });

export type GuardContext = Readonly<{
  /** The only folder uploads may come from (<agentCwd>/files); null: every upload is denied. */
  uploadDir: string | null;
  /** Elements seen in this run's snapshots, by ref. */
  refs: Readonly<Record<string, RefInfo>>;
}>;

/** Refs an element tool acts on: `target` (current MCP) or `ref`, and every field of fill_form. */
function elementRefs(name: string, input: Record<string, unknown>): unknown[] {
  if (name === 'browser_fill_form') {
    return Array.isArray(input.fields)
      ? input.fields.map((field) => (typeof field === 'object' && field !== null ? (field as Record<string, unknown>).target ?? (field as Record<string, unknown>).ref : undefined))
      : [undefined];
  }
  return [input.target ?? input.ref];
}

/**
 * The agent's own description of the element: the whole click call (as before), but only the
 * element label for typing and selects, so an answer text with "send" in it is not a submit.
 */
function agentWords(name: string, input: Record<string, unknown>): string {
  if (name === 'browser_click') return JSON.stringify(input);
  if (name === 'browser_fill_form' && Array.isArray(input.fields)) {
    return JSON.stringify(input.fields.map((field) => (typeof field === 'object' && field !== null ? (field as Record<string, unknown>).name : null)));
  }
  return String(input.element ?? '');
}

const elementTools = new Set(['browser_click', 'browser_type', 'browser_select_option', 'browser_fill_form']);

/** Unknown ref, a ref whose real name has a submit word, or the agent's own words have one. */
function elementCheck(name: string, input: Record<string, unknown>, refs: GuardContext['refs']): 'unknown' | 'submit' | 'ok' {
  const known = elementRefs(name, input).map((ref) => (typeof ref === 'string' ? refs[ref] : undefined));
  if (known.some((info) => info === undefined)) return 'unknown';
  const real = known.some((info) => submitWords.test(`${info!.role} ${info!.name} ${info!.text}`));
  return real || submitWords.test(agentWords(name, input)) ? 'submit' : 'ok';
}

export function guardDecision(mode: ApplyMode, tool: string, args: unknown, state: GuardState, context: GuardContext): GuardDecision {
  const { uploadDir } = context;
  const input = (typeof args === 'object' && args !== null && !Array.isArray(args) ? args : {}) as Record<string, unknown>;
  // press_key is not in the allowed list at all; Enter gets its own explanation.
  if (tool === `${playwright}browser_press_key` && /enter/i.test(String(input.key))) return deny(denyReasons.enter, state);
  if (!allowedTools.includes(tool)) return deny(denyReasons.notAllowed, state);
  if (builtinTools.includes(tool)) return { allow: true, state };
  const name = tool.slice(playwright.length);

  if (name === 'browser_type' && input.submit) return deny(denyReasons.typeSubmit, state);
  if (elementTools.has(name)) {
    const check = elementCheck(name, input, context.refs);
    if (check === 'unknown') return deny(denyReasons.unknownRef, state);
    if (check === 'submit') {
      // Only a click may be the one submit; typing into or selecting a submit-named element never is.
      if (mode === 'fill' || name !== 'browser_click') return deny(denyReasons.submitInFill, state);
      if (state.submitClicks >= 1) return deny(denyReasons.secondSubmit, state);
      return { allow: true, state: { ...state, submitClicks: state.submitClicks + 1 } };
    }
  }

  switch (name) {
    case 'browser_navigate':
      if (!isLinkedinUrl(input.url)) return deny(denyReasons.foreignSite, state);
      break;
    case 'browser_tabs':
      // A new tab may carry its own URL.
      if (input.url !== undefined && !isLinkedinUrl(input.url)) return deny(denyReasons.foreignSite, state);
      break;
    case 'browser_file_upload': {
      const paths = input.paths;
      if (paths === undefined) break; // cancels the file chooser
      if (!uploadDir) return deny(denyReasons.noUploadDir, state);
      if (!Array.isArray(paths) || !paths.every((file) => isUploadFile(file, uploadDir))) return deny(uploadDenyReason(uploadDir), state);
      break;
    }
  }
  return { allow: true, state };
}
