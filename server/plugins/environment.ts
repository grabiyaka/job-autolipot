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
 * defaults: without them the cost cannot be counted, so this fails.
 */
export function claudeAgentConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ClaudeAgentConfig {
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
  return {
    claudeBin: 'claude',
    settingsPath: settings.startsWith('~/') ? path.join(homedir(), settings.slice(2)) : settings,
    mcpUrl: env.PLAYWRIGHT_MCP_URL?.trim() || defaultMcpUrl,
    workDir: defaultAgentWorkDir,
    agentCwd: env.AGENT_CWD?.trim() || defaultAgentCwd,
    timeoutMs,
    prices: { input: price('DEEPSEEK_PRICE_INPUT'), cacheRead: price('DEEPSEEK_PRICE_CACHE_READ'), output: price('DEEPSEEK_PRICE_OUTPUT') },
  };
}

export type ApplyEnvSettings = Readonly<{
  /** APPLY_MAX_PER_RUN: agent runs per fill call (default 5). */
  maxPerRun: number;
  /** APPLY_MAX_USD_PER_DAY: spent on attempts since 00:00 UTC (default 0.5). */
  maxUsdPerDay: number;
  /** APPLY_CV_FILE: the CV's file name in /srv/agent-files; null — the only PDF there is taken. */
  cvFile: string | null;
  /** AGENT_CWD of the agent: the CV copy is uploaded from its files/. */
  agentCwd: string;
}>;

/** Limits and the CV of applying; unlike the agent config, nothing here is required. */
export function applySettingsFromEnv(env: NodeJS.ProcessEnv = process.env): ApplyEnvSettings {
  const maxRaw = env.APPLY_MAX_PER_RUN?.trim();
  const maxPerRun = maxRaw ? Number(maxRaw) : 5;
  if (!Number.isInteger(maxPerRun) || maxPerRun <= 0) throw new Error(`APPLY_MAX_PER_RUN должно быть положительным целым, получено "${maxRaw}"`);
  const usdRaw = env.APPLY_MAX_USD_PER_DAY?.trim();
  const maxUsdPerDay = usdRaw ? Number(usdRaw) : 0.5;
  if (!Number.isFinite(maxUsdPerDay) || maxUsdPerDay < 0) throw new Error(`APPLY_MAX_USD_PER_DAY должно быть неотрицательным числом, получено "${usdRaw}"`);
  return { maxPerRun, maxUsdPerDay, cvFile: env.APPLY_CV_FILE?.trim() || null, agentCwd: env.AGENT_CWD?.trim() || defaultAgentCwd };
}
