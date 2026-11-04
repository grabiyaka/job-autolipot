import { config } from 'dotenv';
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
