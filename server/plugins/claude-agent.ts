import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, chmod, copyFile, mkdir, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentFilesDir, allowedTools, disallowedTools, guardLogFile, httpsHost, screenshotsDir } from './agent-guard-rules.js';
import type { ApplyMode } from './agent-guard-rules.js';

/**
 * Runs `claude -p` (on DeepSeek through `--settings`) as a browser agent with Playwright MCP and
 * returns its structured answer. Knows nothing about job applications: the prompt, the system
 * prompt and the answer schema come from the caller.
 *
 * Safety does not rely on the prompt: only the Playwright tools in `allowedTools` are allowed, and
 * every call first goes through the PreToolUse hook scripts/agent-guard.ts (rules in
 * agent-guard-rules.ts), which gets the mode through APPLY_MODE and the start URL through APPLY_START_URL.
 *
 * Two folders:
 * - `agentCwd` (by default /srv/agent-files/agent-run): cwd of `claude`, with its .claude/settings.json
 *   and mcp.json (`--setting-sources project` keeps ~/.claude out), and files/ with copies of the
 *   top-level documents of /srv/agent-files. Playwright MCP allows uploads only from its output dir and
 *   the client's cwd, and the MCP service (user agent, ProtectHome=yes) cannot see /home, so the cwd
 *   and the files must live outside /home in a folder the agent group can read.
 * - `workDir` (by default server/data/agent): runs/<id>/ of each run with the system prompt and the
 *   guard log; private to this app.
 *
 * Backend: with `settingsPath` — DeepSeek through `--settings`; cost is counted from tokens and DeepSeek
 * prices (USD per 1M tokens), `total_cost_usd` of `claude` is ignored (it uses Claude prices). With
 * `settingsPath: null` — the logged-in Claude account (subscription); cost is `total_cost_usd`
 * (list price, notional on a subscription), and the ANTHROPIC_* overrides of the parent env are dropped. The settings file carries the API key in its `env`: this module
 * only checks that it exists and never reads or logs it.
 */

export type AgentPrices = Readonly<{
  /** USD per 1M input tokens (cache miss, including cache writes). */
  input: number;
  /** USD per 1M input tokens read from the cache. */
  cacheRead: number;
  /** USD per 1M output tokens. */
  output: number;
}>;

export type ClaudeAgentConfig = Readonly<{
  /** `claude` executable; a bare name is looked up in PATH. */
  claudeBin: string;
  /** --settings file (DeepSeek env); only its existence is checked. null — the logged-in Claude account. */
  settingsPath: string | null;
  /** --model (Claude backend), e.g. `sonnet`. */
  model?: string;
  /** Playwright MCP over HTTP. */
  mcpUrl: string;
  /** runs/<id>/ of each run (system prompt, guard log) go here; created when missing. */
  workDir: string;
  /** cwd of `claude`: settings, mcp.json and files/ with the copies to upload; must be readable by the MCP service. */
  agentCwd: string;
  /** Source of the files to upload; top-level .pdf/.doc/.docx are copied into <agentCwd>/files/. */
  filesSource?: string;
  /** One run is killed after this. */
  timeoutMs: number;
  /** DeepSeek prices; null — cost is `total_cost_usd` of `claude` (Claude backend). */
  prices: AgentPrices | null;
  /** Shell command of the PreToolUse hook; by default the guard script of this server. */
  guardCommand?: string;
  /** Time between SIGTERM and SIGKILL. */
  killGraceMs?: number;
}>;

export type AgentRunRequest = Readonly<{
  prompt: string;
  systemPrompt: string;
  /** JSON schema of the answer (--json-schema). */
  schema: object;
  mode: ApplyMode;
  /**
   * https URL the agent starts from (a job page outside LinkedIn, or the external form for
   * submit_fresh). The guard lets the browser open its host (APPLY_START_URL); the caller still puts
   * it into the prompt. Without it only LinkedIn, known ATS and hosts reached by clicks are allowed.
   */
  startUrl?: string;
  /** Continue this session (--resume), e.g. submit after fill. */
  resumeSessionId?: string;
  signal?: AbortSignal;
}>;

export type AgentTokens = Readonly<{ input: number; cacheRead: number; output: number }>;

/** One tool call as the guard saw it. */
export type GuardLogEntry = Readonly<{
  at: string; mode?: string; tool: string; page?: string | null; args: unknown; decision: 'allow' | 'deny'; reason?: string;
  /** The allowed send click of the attempt (submit modes); absent in entries of older guards. */
  submit?: boolean;
}>;

export type AgentRunResult = Readonly<{
  /** `structured_output`: matches the schema as far as `claude` checks it; the caller validates. */
  output: unknown;
  subtype: string;
  sessionId: string;
  turns: number;
  durationMs: number;
  tokens: AgentTokens;
  costMicros: number;
  guardLog: GuardLogEntry[];
  /** runs/<id>/ of this run. */
  runDir: string;
  /** Images the hook saved from browser_take_screenshot, in order (runs/<id>/screenshots/). */
  screenshots: string[];
}>;

export type ClaudeAgent = Readonly<{
  config: ClaudeAgentConfig;
  run(request: AgentRunRequest): Promise<AgentRunResult>;
}>;

/** What is known about a failed run; tokens and cost are there when `claude` reported them. */
export type AgentFailure = Readonly<{
  runDir?: string;
  guardLog?: GuardLogEntry[];
  screenshots?: string[];
  subtype?: string;
  sessionId?: string;
  turns?: number;
  tokens?: AgentTokens;
  costMicros?: number;
}>;

export class AgentError extends Error {
  override name = 'AgentError';
  readonly runDir: string | undefined;
  readonly guardLog: GuardLogEntry[];
  readonly screenshots: string[];
  readonly subtype: string | undefined;
  readonly sessionId: string | undefined;
  readonly turns: number | undefined;
  readonly tokens: AgentTokens | undefined;
  readonly costMicros: number | undefined;
  constructor(message: string, failure: AgentFailure = {}) {
    super(message);
    this.runDir = failure.runDir;
    this.guardLog = failure.guardLog ?? [];
    this.screenshots = failure.screenshots ?? [];
    this.subtype = failure.subtype;
    this.sessionId = failure.sessionId;
    this.turns = failure.turns;
    this.tokens = failure.tokens;
    this.costMicros = failure.costMicros;
  }
}
/** No `claude` executable or no settings file. */
export class AgentUnavailableError extends AgentError {
  override name = 'AgentUnavailableError';
}
/** The run did not finish within `timeoutMs` and was killed. */
export class AgentTimeoutError extends AgentError {
  override name = 'AgentTimeoutError';
}
/** `claude` finished without a usable answer: not JSON, an error subtype (error_max_turns…) or no structured_output. */
export class AgentResponseError extends AgentError {
  override name = 'AgentResponseError';
}

export const defaultMcpUrl = 'http://127.0.0.1:8931/mcp';
export const defaultApplyTimeoutMs = 10 * 60_000;

/** server/, also when this file runs from dist/plugins. */
const serverDir = (() => {
  const parent = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  return path.basename(parent) === 'dist' ? path.dirname(parent) : parent;
})();
export const defaultAgentWorkDir = path.join(serverDir, 'data', 'agent');
export const defaultAgentCwd = '/srv/agent-files/agent-run';
const uploadExtensions = new Set(['.pdf', '.doc', '.docx']);

/** Folder of the copies the agent may upload. */
export const agentUploadDir = (agentCwd: string = defaultAgentCwd): string => path.join(agentCwd, 'files');

/** Path of the copy of /srv/agent-files/<fileName> that the agent uploads; for the prompt. */
export function agentUploadPath(fileName: string, agentCwd: string = defaultAgentCwd): string {
  if (!fileName || fileName !== path.basename(fileName)) throw new Error(`Имя файла для загрузки без пути: «${fileName}»`);
  return path.join(agentUploadDir(agentCwd), fileName);
}

/** File system calls of syncAgentFiles that tests replace to simulate a foreign group or a lost setgid. */
export type AgentFilesFs = Readonly<{ stat: typeof stat; chmod: typeof chmod }>;
const realFs: AgentFilesFs = { stat, chmod };

const setgid = 0o2000;
const folderMode = 0o2750;
const fileMode = 0o640;

/**
 * The upload folder with setgid and 0750, so new files get the group of /srv/agent-files (agent).
 * The owner is not in that group, and Linux drops setgid on chmod by a non-member: a folder that lost
 * it cannot be fixed by chmod, so it is removed (only our copies are inside) and created again, which
 * inherits setgid and group from the parent.
 */
async function uploadFolder(target: string, fs: AgentFilesFs): Promise<number> {
  await mkdir(target, { recursive: true, mode: 0o750 });
  const parentSetgid = ((await fs.stat(path.dirname(target))).mode & setgid) !== 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    let info = await fs.stat(target);
    if ((info.mode & 0o7777) !== folderMode) {
      await fs.chmod(target, (info.mode & setgid) || parentSetgid ? folderMode : 0o750);
      info = await fs.stat(target);
    }
    if (!parentSetgid || (info.mode & setgid) !== 0) return info.gid;
    await rm(target, { recursive: true, force: true });
    await mkdir(target, { mode: 0o750 });
  }
  throw new Error(`папка ${target} не получила setgid и группу родителя: файлы будут недоступны Playwright MCP`);
}

/**
 * Copies regular top-level .pdf/.doc/.docx files of `source` into `target` (subfolders and other
 * files are ignored). The folder keeps setgid (02750), copies get 0640 and must have the folder's
 * group, so the agent group of /srv/agent-files can read them. A copy is made again when its size,
 * mtime or group differ; it is removed first, so the new file inherits the folder's group.
 * Returns the copied names.
 */
export async function syncAgentFiles(source: string, target: string, fs: AgentFilesFs = realFs): Promise<string[]> {
  const group = await uploadFolder(target, fs);
  const copied: string[] = [];
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (!entry.isFile() || !uploadExtensions.has(path.extname(entry.name).toLowerCase())) continue;
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    const original = await fs.stat(from);
    const copy = await fs.stat(to).catch(() => null);
    // mtime is compared to 1 ms: utimes and Date keep no more than that.
    if (copy && copy.size === original.size && Math.abs(copy.mtimeMs - original.mtimeMs) < 1
      && copy.gid === group && (copy.mode & 0o777) === fileMode) continue;
    let ok = false;
    for (let attempt = 0; attempt < 2 && !ok; attempt++) {
      await rm(to, { force: true });
      await copyFile(from, to);
      await fs.chmod(to, fileMode);
      await utimes(to, original.atimeMs / 1000, original.mtimeMs / 1000);
      ok = (await fs.stat(to)).gid === group;
    }
    if (!ok) {
      await rm(to, { force: true });
      throw new Error(`копия ${to} не получила группу папки (gid ${group}): Playwright MCP не сможет её прочитать`);
    }
    copied.push(entry.name);
  }
  return copied;
}

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/**
 * node + tsx + scripts/agent-guard.ts. `|| exit 2`: if the guard cannot even start, exit code 2 makes
 * `claude` block the call instead of letting it through.
 */
export function defaultGuardCommand(): string {
  const tsx = path.join(serverDir, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const script = path.join(serverDir, 'scripts', 'agent-guard.ts');
  return `${quote(process.execPath)} ${quote(tsx)} ${quote(script)} || exit 2`;
}

const maxStdout = 16 * 1024 * 1024;
const snippetChars = 300;
const snippet = (text: string) => {
  const trimmed = text.trim();
  return trimmed.length > snippetChars ? `…${trimmed.slice(-snippetChars)}` : trimmed;
};

export function agentArgs(files: Readonly<{ mcpConfig: string; systemPromptFile: string }>, config: ClaudeAgentConfig, request: AgentRunRequest): string[] {
  return [
    '-p', request.prompt,
    ...(config.settingsPath ? ['--settings', config.settingsPath] : []),
    ...(config.model ? ['--model', config.model] : []),
    '--setting-sources', 'project',
    '--mcp-config', files.mcpConfig, '--strict-mcp-config',
    '--system-prompt-file', files.systemPromptFile,
    '--allowedTools', allowedTools.join(','),
    '--disallowedTools', disallowedTools.join(','),
    '--permission-mode', 'dontAsk',
    '--json-schema', JSON.stringify(request.schema),
    '--output-format', 'json',
    ...(request.resumeSessionId ? ['--resume', request.resumeSessionId] : []),
  ];
}

/** Micro-dollars: tokens × USD per 1M tokens. */
export function costMicros(tokens: AgentTokens, prices: AgentPrices): number {
  return Math.round(tokens.input * prices.input + tokens.cacheRead * prices.cacheRead + tokens.output * prices.output);
}

const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0);

/** Sum over models of `modelUsage`; falls back to `usage` when there is no per-model block. */
export function resultTokens(result: Record<string, unknown>): AgentTokens {
  const models = result.modelUsage;
  if (typeof models === 'object' && models !== null && Object.keys(models).length) {
    const tokens = { input: 0, cacheRead: 0, output: 0 };
    for (const usage of Object.values(models as Record<string, Record<string, unknown> | null>)) {
      if (!usage) continue;
      tokens.input += count(usage.inputTokens) + count(usage.cacheCreationInputTokens);
      tokens.cacheRead += count(usage.cacheReadInputTokens);
      tokens.output += count(usage.outputTokens);
    }
    return tokens;
  }
  const usage = (typeof result.usage === 'object' && result.usage !== null ? result.usage : {}) as Record<string, unknown>;
  return {
    input: count(usage.input_tokens) + count(usage.cache_creation_input_tokens),
    cacheRead: count(usage.cache_read_input_tokens),
    output: count(usage.output_tokens),
  };
}

async function readGuardLog(runDir: string): Promise<GuardLogEntry[]> {
  let text: string;
  try { text = await readFile(path.join(runDir, guardLogFile), 'utf8'); } catch { return []; }
  return text.split('\n').filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line) as GuardLogEntry]; } catch { return []; }
  });
}

/** The saved screenshots of the run, by name (the hook numbers them in order). */
async function readScreenshots(runDir: string): Promise<string[]> {
  const folder = path.join(runDir, screenshotsDir);
  let names: string[];
  try { names = await readdir(folder); } catch { return []; }
  return names.filter((name) => /^\d+\.(png|jpe?g|webp)$/i.test(name)).sort().map((name) => path.join(folder, name));
}

type Exit = Readonly<{ stdout: string; stderr: string; code: number | null; timedOut: boolean; aborted: boolean }>;

function runProcess(command: string, args: string[], options: Readonly<{
  cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; killGraceMs: number; signal: AbortSignal | undefined;
}>): Promise<Exit> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outSize = 0;
    let errSize = 0;
    let timedOut = false;
    let aborted = false;
    let killTimer: NodeJS.Timeout | undefined;
    const stop = () => {
      child.kill('SIGTERM');
      killTimer ??= setTimeout(() => child.kill('SIGKILL'), options.killGraceMs);
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs);
    const onAbort = () => { aborted = true; stop(); };
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk: Buffer) => {
      outSize += chunk.length;
      if (outSize <= maxStdout) out.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      errSize += chunk.length;
      if (errSize <= 64 * 1024) err.push(chunk);
    });
    const cleanup = () => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', onAbort);
    };
    child.on('error', (error) => { cleanup(); reject(error); });
    child.on('close', (code) => {
      cleanup();
      resolve({ stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), code, timedOut, aborted });
    });
  });
}

/** Writes the agent cwd: .claude/settings.json with the guard hook and mcp.json. */
async function prepareAgentCwd(config: ClaudeAgentConfig): Promise<string> {
  await mkdir(config.agentCwd, { recursive: true, mode: 0o750 });
  await mkdir(path.join(config.agentCwd, '.claude'), { recursive: true, mode: 0o750 });
  const guard = config.guardCommand ?? defaultGuardCommand();
  const settings = {
    hooks: {
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: guard, timeout: 30 }] }],
      // Records the real names of element refs from snapshots; PreToolUse judges clicks by them.
      PostToolUse: [{ matcher: 'mcp__playwright__.*', hooks: [{ type: 'command', command: guard, timeout: 30 }] }],
    },
  };
  await writeFile(path.join(config.agentCwd, '.claude', 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o640 });
  const mcpConfig = path.join(config.agentCwd, 'mcp.json');
  await writeFile(mcpConfig, `${JSON.stringify({ mcpServers: { playwright: { type: 'http', url: config.mcpUrl } } }, null, 2)}\n`, { mode: 0o640 });
  return mcpConfig;
}

function runId(now: Date): string {
  return `${now.toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
}

export function createClaudeAgent(config: ClaudeAgentConfig): ClaudeAgent {
  if (!config.claudeBin) throw new Error('Не задан исполняемый файл claude');
  if (config.settingsPath !== null && !config.settingsPath) throw new Error('Не задан файл настроек DeepSeek (DEEPSEEK_SETTINGS)');
  if (!/^https?:\/\//.test(config.mcpUrl)) throw new Error(`PLAYWRIGHT_MCP_URL должен быть http(s) URL, получено "${config.mcpUrl}"`);
  if (!(config.timeoutMs > 0)) throw new Error('Таймаут агента должен быть положительным');
  if (!path.isAbsolute(config.agentCwd)) throw new Error(`AGENT_CWD должен быть абсолютным путём, получено "${config.agentCwd}"`);
  if (config.settingsPath !== null && !config.prices) throw new Error('Для DeepSeek нужны цены DEEPSEEK_PRICE_*');
  for (const [name, price] of Object.entries(config.prices ?? {})) {
    if (!Number.isFinite(price) || price < 0) throw new Error(`Цена DeepSeek (${name}) должна быть неотрицательным числом`);
  }

  return {
    config,
    async run(request) {
      if (request.prompt.startsWith('-')) throw new Error('Промпт агента не может начинаться с «-»: claude примет его за флаг');
      if (request.startUrl !== undefined && httpsHost(request.startUrl) === null) {
        throw new Error(`Стартовый адрес агента должен быть https URL, получено «${request.startUrl}»`);
      }
      if (config.settingsPath) {
        try {
          await access(config.settingsPath, constants.R_OK);
        } catch {
          throw new AgentUnavailableError(`Нет файла настроек DeepSeek ${config.settingsPath} (DEEPSEEK_SETTINGS)`);
        }
      }
      const mcpConfig = await prepareAgentCwd(config);
      const uploadDir = agentUploadDir(config.agentCwd);
      const filesSource = config.filesSource ?? agentFilesDir;
      try {
        await syncAgentFiles(filesSource, uploadDir);
      } catch (error) {
        throw new AgentUnavailableError(`Не удалось скопировать файлы для загрузки из ${filesSource}: ${(error as Error).message}`);
      }
      const started = Date.now();
      const runDir = path.join(config.workDir, 'runs', runId(new Date(started)));
      await mkdir(runDir, { recursive: true });
      const systemPromptFile = path.join(runDir, 'system.md');
      await writeFile(systemPromptFile, request.systemPrompt);

      // Hooks inherit this env. CLAUDECODE is dropped so a run started from a Claude session is not taken as nested.
      // APPLY_START_URL of the parent is dropped too: only this run's startUrl may widen the allowed hosts.
      const { CLAUDECODE: _nested, APPLY_START_URL: _inherited, ...env } = process.env;
      // On the Claude account a base URL / token / model override of the parent would send the run elsewhere.
      if (config.settingsPath === null) {
        for (const name of Object.keys(env)) if (/^ANTHROPIC_(BASE_URL|AUTH_TOKEN|MODEL|DEFAULT_\w+_MODEL|SMALL_FAST_MODEL)$/.test(name)) delete env[name];
      }
      let exit: Exit;
      try {
        exit = await runProcess(config.claudeBin, agentArgs({ mcpConfig, systemPromptFile }, config, request), {
          cwd: config.agentCwd,
          env: {
            ...env, APPLY_MODE: request.mode, APPLY_GUARD_DIR: runDir, APPLY_UPLOAD_DIR: uploadDir,
            ...(request.startUrl !== undefined ? { APPLY_START_URL: request.startUrl } : {}),
          },
          timeoutMs: config.timeoutMs,
          killGraceMs: config.killGraceMs ?? 5000,
          signal: request.signal,
        });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'EACCES') throw new AgentUnavailableError(`claude не найден или не запускается: ${config.claudeBin}`, { runDir });
        throw error;
      }
      const durationMs = Date.now() - started;
      const guardLog = await readGuardLog(runDir);
      const screenshots = await readScreenshots(runDir);

      if (exit.aborted) throw request.signal?.reason ?? new Error('Запуск агента остановлен');
      if (exit.timedOut) throw new AgentTimeoutError(`Агент не закончил за ${Math.round(config.timeoutMs / 1000)} с и остановлен`, { runDir, guardLog, screenshots });

      let result: Record<string, unknown> | null = null;
      try {
        const data: unknown = JSON.parse(exit.stdout);
        if (typeof data === 'object' && data !== null && !Array.isArray(data)) result = data as Record<string, unknown>;
      } catch { /* reported below */ }
      if (!result) {
        throw new AgentResponseError(
          `claude вернул не JSON (код ${exit.code}): ${snippet(exit.stdout) || snippet(exit.stderr) || 'пустой вывод'}`, { runDir, guardLog, screenshots },
        );
      }

      const subtype = typeof result.subtype === 'string' ? result.subtype : 'unknown';
      const sessionId = typeof result.session_id === 'string' ? result.session_id : '';
      const turns = count(result.num_turns);
      const tokens = resultTokens(result);
      const failure: AgentFailure = { runDir, guardLog, screenshots, subtype, sessionId, turns, tokens, costMicros: config.prices ? costMicros(tokens, config.prices) : Math.round(count(result.total_cost_usd) * 1_000_000) };
      if (subtype !== 'success' || result.is_error === true) {
        const detail = typeof result.result === 'string' && result.result ? `: ${snippet(result.result)}` : '';
        throw new AgentResponseError(`Агент закончил с ${subtype}${result.is_error === true ? ' (is_error)' : ''}${detail}`, failure);
      }
      if (result.structured_output === undefined || result.structured_output === null) {
        throw new AgentResponseError('В ответе агента нет structured_output', failure);
      }
      if (!sessionId) throw new AgentResponseError('В ответе агента нет session_id', failure);

      return {
        output: result.structured_output, subtype, sessionId, turns, durationMs, tokens, costMicros: failure.costMicros!, guardLog, runDir, screenshots,
      };
    },
  };
}
