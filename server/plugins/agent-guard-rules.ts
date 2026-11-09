import path from 'node:path';
import type { RefInfo } from './agent-snapshot-refs.js';

/**
 * Hard rules of the browser agent, checked by the PreToolUse hook (scripts/agent-guard.ts) before
 * every tool call; the prompt asks for the same, but only this is binding. Pure: the hook reads
 * the call and the state, this decides, the hook writes the state back.
 *
 * - fill: never submit — no click on a submit button, no Enter, no `submit: true`.
 * - submit (continue an Easy Apply session) and submit_fresh (open an external form again, fill it
 *   and send it): the same, except one click on a submit button per attempt.
 * - all modes: only https on *.linkedin.com, the host of the start URL, known ATS hosts and hosts the
 *   browser has already been on in this attempt; uploads only from <agentCwd>/files/; only the tools
 *   listed below (Playwright plus the harmless built-ins StructuredOutput and ToolSearch).
 * A false denial is cheaper than a false submission, so "submit" matches any button with that word.
 *
 * browse (the collector agent of the hunt task) is read-only: only the reading tools of `browseTools`;
 * navigation and new tabs only to https on the site's hosts (APPLY_ALLOWED_HOSTS, nothing else — not even
 * hosts reached by clicks); no reading or clicking once the page is on another host; no Enter and no
 * `submit: true` (result pages are opened by URL); typing only into a search-like field, never into an
 * e-mail / password / phone field; no click on an element whose real name (or the agent's own words) says
 * apply, submit, sign in / up, log in, register, subscribe, save the job…; tabs may be opened and listed,
 * never selected or closed (the collector closes the agent's tabs itself).
 *
 * Two kinds of submit words. Strong ones (submit, send, absenden…) mean submit on every page. Apply
 * words (apply, bewerb, postuler, candidat, solicitar) mean submit only on a page outside LinkedIn and
 * only after the agent has typed, selected, uploaded or clicked a checkbox/radio/switch/option on that
 * page (same origin + path):
 * before that "Apply for this job" opens the form, after it the same word sends it. On LinkedIn they
 * mean nothing: "Easy Apply" opens the dialog and "Apply" leads to the company site.
 *
 * Clicks, typing and selects are judged by the element's real role and name from the page's ARIA
 * snapshot (refs.json, collected by the PostToolUse hook), not by the `element` text the agent writes:
 * a Submit button called "Primary button" by the agent is still Submit. A ref the guard has not seen
 * in a snapshot is denied. The agent's own text is checked too; either match denies.
 */

export const applyModes = ['fill', 'submit', 'submit_fresh'] as const;
export type ApplyMode = typeof applyModes[number];
/** Every mode of the guard: the apply modes and the read-only `browse` of the collector agent. */
export type AgentMode = ApplyMode | 'browse';

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

/** Tools of the read-only collector agent (browse mode). */
export const browseTools = [
  ...builtinTools,
  ...['browser_navigate', 'browser_navigate_back', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_press_key', 'browser_wait_for', 'browser_tabs']
    .map((name) => `${playwright}${name}`),
];
export const browseDisallowedTools = [
  'Bash', 'Edit', 'Write', 'NotebookEdit', 'Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'Task', 'Agent',
  ...['browser_evaluate', 'browser_run_code_unsafe', 'browser_file_upload', 'browser_fill_form', 'browser_select_option', 'browser_handle_dialog',
    'browser_close', 'browser_drag', 'browser_drop', 'browser_take_screenshot', 'browser_find'].map((name) => `${playwright}${name}`),
];

/** --allowedTools / --disallowedTools of a run in this mode. */
export const toolsForMode = (mode: AgentMode): Readonly<{ allowed: readonly string[]; disallowed: readonly string[] }> =>
  (mode === 'browse' ? { allowed: browseTools, disallowed: browseDisallowedTools } : { allowed: allowedTools, disallowed: disallowedTools });

/**
 * Where the user keeps files for the agent (CV). Playwright MCP may not read it directly: the plugin
 * copies its files into <agentCwd>/files/, and only that copy may be uploaded.
 */
export const agentFilesDir = '/srv/agent-files/';
/** One JSON line per tool call, in the attempt's folder (APPLY_GUARD_DIR). */
export const guardLogFile = 'guard-log.jsonl';
/** Subfolder of the run where the hook saves the images of browser_take_screenshot (001.png, 002.jpeg…). */
export const screenshotsDir = 'screenshots';

export type GuardState = Readonly<{
  submitClicks: number;
  /** origin + path of the pages where the agent typed, selected or uploaded in this attempt. */
  inputPages: readonly string[];
}>;
export const initialGuardState: GuardState = { submitClicks: 0, inputPages: [] };

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

/**
 * Words of an "apply" button on company sites and ATS (Apply / Jetzt bewerben / Postuler /
 * Candidater / Solicitar). Before any input on the page it opens the form, after input it sends it.
 * Not used on LinkedIn pages, and not for form controls (a checkbox "Candidate privacy policy").
 */
export const applyWords = /apply|bewerb|postuler|candidat|solicitar/iu;
/** A question hint, not a button: «Which technologies… (Select all that apply.)». */
const notApply = /all that apply/giu;
const hasApplyWord = (text: string) => applyWords.test(text.replace(notApply, ''));
const formControlRoles = new Set(['checkbox', 'radio', 'textbox', 'searchbox', 'combobox', 'listbox', 'option', 'switch', 'spinbutton', 'slider']);

/**
 * Hosts of applicant tracking systems that need no account; a subdomain matches
 * (boards.greenhouse.io, jobs.lever.co, acme.recruitee.com…).
 */
export const atsDomains = [
  'greenhouse.io', 'lever.co', 'ashbyhq.com', 'workable.com', 'smartrecruiters.com', 'teamtailor.com',
  'personio.de', 'personio.com', 'recruitee.com', 'bamboohr.com', 'breezy.hr', 'jobvite.com',
] as const;

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
  foreignSite: 'Host not allowed for this attempt. If the application needs another site, stop and report outcome "manual".',
  noUploadDir: 'Uploads are not configured in this run (APPLY_UPLOAD_DIR).',
  unknownRef: 'Take browser_snapshot first: unknown element ref.',
  browseOnly: 'Read-only run: do not apply, sign in, sign up, register, subscribe or save anything. Read the page instead.',
  browseSite: 'Only the job board of this run may be opened. Stay on its pages.',
  browseOffSite: 'The page is not on the job board of this run: go back (browser_navigate_back) or navigate to the board.',
  browseEnter: 'Enter is not allowed in this run: open the results page by its URL, or click the search button.',
  browseTypeSubmit: 'submit: true is not allowed in this run: click the search button instead.',
  browseTypeField: 'Typing is allowed only into a search field (keywords, location), never e-mail, password or other form fields.',
  browseTabs: 'Only browser_tabs "new" and "list" are allowed: the collector switches and closes tabs itself.',
} as const;

/**
 * Words of buttons and links a read-only collector never clicks: applying, sending, accounts, subscriptions,
 * saving a job, posting a job (English, Russian, Ukrainian, German).
 */
export const browseDenyWords = new RegExp([
  'apply', 'submit', 'send', 'sign.?in', 'sign.?up', 'log.?in', 'log.?on', 'register', 'subscri', 'create.{0,12}account', 'join now',
  'save.{0,6}job', 'save this', 'post.{0,3}a.{0,3}job', 'hire', 'continue with', 'upload', 'unlock', 'upgrade', 'premium', 'checkout', 'buy',
  'bewerb', 'anmeld', 'registrier', 'отклик', 'откликн', 'відгук', 'войти', 'вход', 'увійти', 'регистр', 'зареєстр', 'подпис', 'підпис', 'отправ', 'надісл', 'сохран', 'зберег',
].join('|'), 'iu');
/** A field that takes a search query; anything personal is never typed into. */
const searchFieldWords = /search|keyword|query|what|where|title|skill|location|city|role|position|job|find|пошук|поиск|ключ|посад|должн|місто|город/iu;
const personalFieldWords = /mail|password|passwort|пароль|phone|телефон|login|user.?name|card|cvv|first.?name|last.?name|full.?name|ім'я|имя/iu;
const searchFieldRoles = new Set(['searchbox', 'textbox', 'combobox']);

export function parseApplyMode(value: string | undefined): AgentMode {
  // Anything unknown gets the stricter mode.
  return value === 'submit' || value === 'submit_fresh' || value === 'browse' ? value : 'fill';
}

/** Lower-case host of an https URL; null for anything else (http, about:, not a URL). */
export function httpsHost(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  return url.protocol === 'https:' && url.hostname ? url.hostname.toLowerCase() : null;
}

/** `host` is `domain` or its subdomain (the dot boundary keeps evillinkedin.com out). */
export function isHostIn(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/** True only for https URLs on linkedin.com or its subdomains. */
export function isLinkedinUrl(value: unknown): boolean {
  const host = httpsHost(value);
  return host !== null && isHostIn(host, 'linkedin.com');
}

/** https on LinkedIn, an ATS, the start URL's host or a host already visited in this attempt. */
export function isAllowedUrl(value: unknown, context: Pick<GuardContext, 'startHost' | 'visitedHosts'>): boolean {
  const host = httpsHost(value);
  if (host === null) return false;
  return isHostIn(host, 'linkedin.com') || atsDomains.some((domain) => isHostIn(host, domain))
    || host === context.startHost || context.visitedHosts.includes(host);
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
  /** origin + path of the current page (from the last tool response); null before the first one. */
  page: string | null;
  /** Host of the start URL of this attempt (APPLY_START_URL), null without one. */
  startHost: string | null;
  /** https hosts the browser has been on in this attempt (Page URL of tool responses). */
  visitedHosts: readonly string[];
  /** browse mode: the only https hosts the browser may open (APPLY_ALLOWED_HOSTS); absent or empty — none. */
  allowedHosts?: readonly string[];
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
/** Tools that put something into the form; after one of them an apply word sends it. */
const inputTools = new Set(['browser_type', 'browser_select_option', 'browser_fill_form', 'browser_file_upload']);

/**
 * Unknown ref; every ref a form control (by its real role) — never a submit, whatever its label says
 * («By submitting this application, I agree…»); a ref whose real name, or the agent's own words, have
 * a submit word; or, for a click on a page outside LinkedIn, an apply word.
 */
function elementCheck(name: string, input: Record<string, unknown>, context: GuardContext): 'unknown' | 'submit' | 'apply' | 'ok' {
  const known = elementRefs(name, input).map((ref) => (typeof ref === 'string' ? context.refs[ref] : undefined));
  if (known.some((info) => info === undefined)) return 'unknown';
  if (known.every((info) => formControlRoles.has(info!.role))) return 'ok';
  const real = known.map((info) => `${info!.role} ${info!.name} ${info!.text}`);
  const words = agentWords(name, input);
  if (real.some((text) => submitWords.test(text)) || submitWords.test(words)) return 'submit';
  const external = context.page !== null && !isLinkedinUrl(context.page);
  if (name !== 'browser_click' || !external) return 'ok';
  return real.some(hasApplyWord) || hasApplyWord(words) ? 'apply' : 'ok';
}

/** Form controls a click changes; such a click is input too (role from the snapshot, not the agent). */
const clickInputRoles = new Set(['checkbox', 'radio', 'switch', 'option']);

/** State after an allowed call: an input (or a click on a checkbox, radio, switch or option) marks the current page. */
function afterAllowed(name: string, input: Record<string, unknown>, state: GuardState, context: GuardContext): GuardDecision {
  const page = context.page;
  const clickedControl = name === 'browser_click' && elementRefs(name, input)
    .some((ref) => typeof ref === 'string' && clickInputRoles.has(context.refs[ref]?.role ?? ''));
  const isInput = clickedControl || (inputTools.has(name) && !(name === 'browser_file_upload' && input.paths === undefined));
  if (!isInput || page === null || state.inputPages.includes(page)) return { allow: true, state };
  return { allow: true, state: { ...state, inputPages: [...state.inputPages, page] } };
}

/** https on one of the hosts of a browse run (exact host). */
export function isBrowseUrl(value: unknown, allowedHosts: readonly string[]): boolean {
  const host = httpsHost(value);
  return host !== null && allowedHosts.includes(host);
}

/** A page outside the board: http(s) on another host. Blank and error pages of the new tab are not off the board. */
function offBoard(page: string | null, allowedHosts: readonly string[]): boolean {
  if (page === null || !/^https?:/i.test(page)) return false;
  try { return !allowedHosts.includes(new URL(page).hostname.toLowerCase()); } catch { return false; }
}

/** browse: the read-only collector; the state never changes (no submit, no input pages). */
function browseDecision(tool: string, input: Record<string, unknown>, state: GuardState, context: GuardContext): GuardDecision {
  const allowedHosts = context.allowedHosts ?? [];
  const allow: GuardDecision = { allow: true, state };
  if (tool === `${playwright}browser_press_key` && /enter/i.test(String(input.key))) return deny(denyReasons.browseEnter, state);
  if (!browseTools.includes(tool)) return deny(denyReasons.notAllowed, state);
  if (builtinTools.includes(tool)) return allow;
  const name = tool.slice(playwright.length);
  switch (name) {
    case 'browser_navigate':
      return isBrowseUrl(input.url, allowedHosts) ? allow : deny(denyReasons.browseSite, state);
    case 'browser_navigate_back':
      return allow;
    case 'browser_tabs':
      if (input.action === 'list') return allow;
      if (input.action !== 'new') return deny(denyReasons.browseTabs, state);
      return input.url === undefined || isBrowseUrl(input.url, allowedHosts) ? allow : deny(denyReasons.browseSite, state);
  }
  if (offBoard(context.page, allowedHosts)) return deny(denyReasons.browseOffSite, state);
  if (name === 'browser_type' && input.submit) return deny(denyReasons.browseTypeSubmit, state);
  if (name !== 'browser_click' && name !== 'browser_type') return allow; // snapshot, wait_for, other keys

  const ref = input.target ?? input.ref;
  const info = typeof ref === 'string' ? context.refs[ref] : undefined;
  if (!info) return deny(denyReasons.unknownRef, state);
  if (name === 'browser_type') {
    const field = `${info.name} ${info.text} ${String(input.element ?? '')}`;
    const searchField = info.role === 'searchbox' || (searchFieldRoles.has(info.role) && searchFieldWords.test(field));
    return searchField && !personalFieldWords.test(field) ? allow : deny(denyReasons.browseTypeField, state);
  }
  // A link or button is judged by its real name; descendant text only when it has none (a card's
  // «Easily apply» badge must not block opening the card). The agent's own words count too.
  const real = `${info.role} ${info.name || info.text}`;
  return browseDenyWords.test(real) || browseDenyWords.test(String(input.element ?? '')) ? deny(denyReasons.browseOnly, state) : allow;
}

export function guardDecision(mode: AgentMode, tool: string, args: unknown, state: GuardState, context: GuardContext): GuardDecision {
  const { uploadDir } = context;
  const input = (typeof args === 'object' && args !== null && !Array.isArray(args) ? args : {}) as Record<string, unknown>;
  if (mode === 'browse') return browseDecision(tool, input, state, context);
  // press_key is not in the allowed list at all; Enter gets its own explanation.
  if (tool === `${playwright}browser_press_key` && /enter/i.test(String(input.key))) return deny(denyReasons.enter, state);
  if (!allowedTools.includes(tool)) return deny(denyReasons.notAllowed, state);
  if (builtinTools.includes(tool)) return { allow: true, state };
  const name = tool.slice(playwright.length);

  if (name === 'browser_type' && input.submit) return deny(denyReasons.typeSubmit, state);
  if (elementTools.has(name)) {
    const check = elementCheck(name, input, context);
    if (check === 'unknown') return deny(denyReasons.unknownRef, state);
    // An apply word sends the form only after input on this page; before it, it opens the form.
    const typedHere = context.page !== null && state.inputPages.includes(context.page);
    if (check === 'submit' || (check === 'apply' && typedHere)) {
      // Only a click may be the one submit; typing into or selecting a submit-named element never is.
      if (mode === 'fill' || name !== 'browser_click') return deny(denyReasons.submitInFill, state);
      if (state.submitClicks >= 1) return deny(denyReasons.secondSubmit, state);
      return { allow: true, state: { ...state, submitClicks: state.submitClicks + 1 } };
    }
  }

  switch (name) {
    case 'browser_navigate':
      if (!isAllowedUrl(input.url, context)) return deny(denyReasons.foreignSite, state);
      break;
    case 'browser_tabs':
      // A new tab may carry its own URL.
      if (input.url !== undefined && !isAllowedUrl(input.url, context)) return deny(denyReasons.foreignSite, state);
      break;
    case 'browser_file_upload': {
      const paths = input.paths;
      if (paths === undefined) break; // cancels the file chooser
      if (!uploadDir) return deny(denyReasons.noUploadDir, state);
      if (!Array.isArray(paths) || !paths.every((file) => isUploadFile(file, uploadDir))) return deny(uploadDenyReason(uploadDir), state);
      break;
    }
  }
  return afterAllowed(name, input, state, context);
}
