import { homedir } from 'node:os';
import path from 'node:path';
import { config } from 'dotenv';
import { defaultAgentCwd, defaultAgentWorkDir, defaultApplyTimeoutMs, defaultMcpUrl } from './claude-agent.js';
import type { ClaudeAgentConfig } from './claude-agent.js';
import { defaultOllamaConfig } from './ollama.js';
import type { OllamaConfig } from './ollama.js';
import type { JobTrackerConfig } from './job-tracker.js';

// Source and compiled entry points run with server/ as cwd, while shared settings live above it.
config({ path: '../.env', quiet: true });

/** Ollama settings (OLLAMA_*); unset values fall back to defaultOllamaConfig. */
export function ollamaConfigFromEnv(env: NodeJS.ProcessEnv = process.env): OllamaConfig {
  const number = (name: string, fallback: number): number => {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} должно быть положительным целым, получено "${raw}"`);
    return value;
  };
  return {
    baseUrl: env.OLLAMA_URL || defaultOllamaConfig.baseUrl,
    model: env.OLLAMA_MODEL || defaultOllamaConfig.model,
    numCtx: number('OLLAMA_NUM_CTX', defaultOllamaConfig.numCtx),
    numPredict: defaultOllamaConfig.numPredict,
    timeoutMs: number('OLLAMA_TIMEOUT_MS', defaultOllamaConfig.timeoutMs),
  };
}

/** Job-Tracker settings (JOB_TRACKER_URL, JOB_TRACKER_TOKEN); null when either is unset, so the app runs without it. */
export function jobTrackerConfigFromEnv(env: NodeJS.ProcessEnv = process.env): JobTrackerConfig | null {
  const baseUrl = env.JOB_TRACKER_URL?.trim();
  const token = env.JOB_TRACKER_TOKEN?.trim();
  return baseUrl && token ? { baseUrl, token, timeoutMs: 15_000 } : null;
}

/**
 * Browser agent settings: APPLY_TIMEOUT_MS, DEEPSEEK_SETTINGS, PLAYWRIGHT_MCP_URL, AGENT_CWD and the DeepSeek
 * prices DEEPSEEK_PRICE_INPUT / _CACHE_READ / _OUTPUT (USD per 1M tokens). The prices have no
 * defaults: without them the cost cannot be counted, so this fails. The `claude` backend (APPLY_AGENT or the
 * argument) needs none of DEEPSEEK_*: it runs on the logged-in Claude account with APPLY_CLAUDE_MODEL (sonnet).
 */
export function claudeAgentConfigFromEnv(env: NodeJS.ProcessEnv = process.env, backend: AgentBackend = agentBackendFromEnv(env)): ClaudeAgentConfig {
  const price = (name: string): number => {
    const raw = env[name]?.trim();
    if (!raw) throw new Error(`${name} не задана: укажите цену DeepSeek в USD за 1M токенов в .env`);
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) throw new Error(`${name} должна быть неотрицательным числом, получено "${raw}"`);
    return value;
  };
  const timeout = env.APPLY_TIMEOUT_MS?.trim();
  const timeoutMs = timeout ? Number(timeout) : defaultApplyTimeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error(`APPLY_TIMEOUT_MS должно быть положительным целым, получено "${timeout}"`);
  const settings = env.DEEPSEEK_SETTINGS?.trim() || '~/.config/deepseek/claude-settings.json';
  const claude = backend === 'claude';
  return {
    claudeBin: 'claude',
    settingsPath: claude ? null : settings.startsWith('~/') ? path.join(homedir(), settings.slice(2)) : settings,
    ...(claude ? { model: env.APPLY_CLAUDE_MODEL?.trim() || 'sonnet' } : {}),
    mcpUrl: env.PLAYWRIGHT_MCP_URL?.trim() || defaultMcpUrl,
    workDir: defaultAgentWorkDir,
    agentCwd: env.AGENT_CWD?.trim() || defaultAgentCwd,
    timeoutMs,
    prices: claude ? null : { input: price('DEEPSEEK_PRICE_INPUT'), cacheRead: price('DEEPSEEK_PRICE_CACHE_READ'), output: price('DEEPSEEK_PRICE_OUTPUT') },
  };
}

/** `deepseek` — claude -p on DeepSeek (DEEPSEEK_*); `claude` — the logged-in Claude account (APPLY_CLAUDE_MODEL). */
export type AgentBackend = 'deepseek' | 'claude';

/** APPLY_AGENT: deepseek (default) or claude. */
export function agentBackendFromEnv(env: NodeJS.ProcessEnv = process.env): AgentBackend {
  const raw = env.APPLY_AGENT?.trim().toLowerCase() || 'deepseek';
  if (raw !== 'deepseek' && raw !== 'claude') throw new Error(`APPLY_AGENT должно быть deepseek или claude, получено "${env.APPLY_AGENT}"`);
  return raw;
}

export type ApplyEnvSettings = Readonly<{
  /** APPLY_MAX_PER_RUN: agent runs per fill call (default 5). */
  maxPerRun: number;
  /** APPLY_MAX_USD_PER_DAY (DeepSeek, default 0.5) or APPLY_CLAUDE_MAX_USD_PER_DAY (Claude, default 10, list prices): spent on attempts since 00:00 UTC. */
  maxUsdPerDay: number;
  /** APPLY_CV_FILE: the CV's file name in /srv/agent-files; null — the only PDF there is taken. */
  cvFile: string | null;
  /** AGENT_CWD of the agent: the CV copy is uploaded from its files/. */
  agentCwd: string;
  /** APPLY_AUTO_SUBMIT=true: the agent sends forms itself, without ✅ (default false). */
  autoSubmit: boolean;
}>;

/** Limits and the CV of applying; unlike the agent config, nothing here is required. */
export function applySettingsFromEnv(env: NodeJS.ProcessEnv = process.env, backend: AgentBackend = agentBackendFromEnv(env)): ApplyEnvSettings {
  const maxRaw = env.APPLY_MAX_PER_RUN?.trim();
  const maxPerRun = maxRaw ? Number(maxRaw) : 5;
  if (!Number.isInteger(maxPerRun) || maxPerRun <= 0) throw new Error(`APPLY_MAX_PER_RUN должно быть положительным целым, получено "${maxRaw}"`);
  const usdName = backend === 'claude' ? 'APPLY_CLAUDE_MAX_USD_PER_DAY' : 'APPLY_MAX_USD_PER_DAY';
  const usdRaw = env[usdName]?.trim();
  const maxUsdPerDay = usdRaw ? Number(usdRaw) : backend === 'claude' ? 10 : 0.5;
  if (!Number.isFinite(maxUsdPerDay) || maxUsdPerDay < 0) throw new Error(`${usdName} должно быть неотрицательным числом, получено "${usdRaw}"`);
  const autoRaw = env.APPLY_AUTO_SUBMIT?.trim().toLowerCase() || 'false';
  if (!['true', 'false'].includes(autoRaw)) throw new Error(`APPLY_AUTO_SUBMIT должно быть true или false, получено "${env.APPLY_AUTO_SUBMIT}"`);
  return {
    maxPerRun, maxUsdPerDay, cvFile: env.APPLY_CV_FILE?.trim() || null, agentCwd: env.AGENT_CWD?.trim() || defaultAgentCwd, autoSubmit: autoRaw === 'true',
  };
}

export type RemoteBrowserEnvSettings = Readonly<{ mcpUrl: string; port: number; publicUrl: string }>;

/**
 * The remote browser of the bot (plugins/remote-browser.ts): REMOTE_BROWSER_PUBLIC_URL — the public https address
 * of the page (Tailscale HTTPS in front of 127.0.0.1:REMOTE_BROWSER_PORT, default 3420); PLAYWRIGHT_MCP_URL — the
 * agent's Playwright MCP. Null without REMOTE_BROWSER_PUBLIC_URL: the «🖥 Открыть браузер» button then says so.
 */
export function remoteBrowserSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): RemoteBrowserEnvSettings | null {
  const publicUrl = env.REMOTE_BROWSER_PUBLIC_URL?.trim().replace(/\/+$/, '');
  if (!publicUrl) return null;
  if (!/^https?:\/\/[^/]+/.test(publicUrl)) throw new Error(`REMOTE_BROWSER_PUBLIC_URL должен быть http(s) URL, получено "${publicUrl}"`);
  const portRaw = env.REMOTE_BROWSER_PORT?.trim();
  const port = portRaw ? Number(portRaw) : 3420;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`REMOTE_BROWSER_PORT должен быть портом 1–65535, получено "${portRaw}"`);
  return { mcpUrl: env.PLAYWRIGHT_MCP_URL?.trim() || defaultMcpUrl, port, publicUrl };
}

export const defaultHuntTimeoutMs = 8 * 60_000;

export type HuntEnvSettings = Readonly<{
  /** HUNT_MAX_USD_PER_DAY: list-price USD of the collector agent per day, all owners (default 5). */
  maxUsdPerDay: number;
  /** Playwright MCP of the agent, for closing the tabs it left (PLAYWRIGHT_MCP_URL). */
  mcpUrl: string;
}>;

/**
 * The collector agent of the hunt task: always the logged-in Claude account (subscription), never DeepSeek;
 * HUNT_MODEL (default sonnet), HUNT_TIMEOUT_MS per agent run (default 8 min); MCP and AGENT_CWD as for applying.
 */
export function huntAgentConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ClaudeAgentConfig {
  const timeout = env.HUNT_TIMEOUT_MS?.trim();
  const timeoutMs = timeout ? Number(timeout) : defaultHuntTimeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error(`HUNT_TIMEOUT_MS должно быть положительным целым, получено "${timeout}"`);
  return {
    claudeBin: 'claude',
    settingsPath: null,
    model: env.HUNT_MODEL?.trim() || 'sonnet',
    mcpUrl: env.PLAYWRIGHT_MCP_URL?.trim() || defaultMcpUrl,
    workDir: path.join(defaultAgentWorkDir, 'hunt'),
    agentCwd: env.AGENT_CWD?.trim() || defaultAgentCwd,
    timeoutMs,
    prices: null,
  };
}

export function huntSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): HuntEnvSettings {
  const raw = env.HUNT_MAX_USD_PER_DAY?.trim();
  const maxUsdPerDay = raw ? Number(raw) : 5;
  if (!Number.isFinite(maxUsdPerDay) || maxUsdPerDay < 0) throw new Error(`HUNT_MAX_USD_PER_DAY должно быть неотрицательным числом, получено "${raw}"`);
  return { maxUsdPerDay, mcpUrl: env.PLAYWRIGHT_MCP_URL?.trim() || defaultMcpUrl };
}
