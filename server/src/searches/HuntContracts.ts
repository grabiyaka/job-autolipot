import type { HuntTab } from './HuntRules.js';

/**
 * Ports of the agent collector (task hunt); composition connects them to the claude-agent plugin and to
 * Playwright MCP, tests to fakes.
 */

export type HuntAgentRequest = Readonly<{
  prompt: string;
  systemPrompt: string;
  /** JSON schema of the answer. */
  schema: object;
  /** https hosts the guard lets the browser open (read-only `browse` mode). */
  allowedHosts: readonly string[];
  maxTurns: number;
  signal: AbortSignal;
}>;

export type HuntAgentResult = Readonly<{ output: unknown; costMicros: number; turns: number; durationMs: number }>;

/** A run of the agent that gave no answer; `costMicros` is what it still cost. */
export class HuntAgentError extends Error {
  override name = 'HuntAgentError';
  constructor(
    message: string,
    readonly costMicros: number,
    /** No `claude` or no MCP: every next run would fail the same way. */
    readonly unavailable = false,
  ) {
    super(message);
  }
}

/** The browser agent (Claude subscription, Playwright MCP) in read-only mode. */
export interface HuntAgent {
  run(request: HuntAgentRequest): Promise<HuntAgentResult>;
}

/** The tabs of the shared browser, so the collector closes what its agent opened. */
export interface HuntTabs {
  list(): Promise<HuntTab[]>;
  close(ids: readonly string[]): Promise<void>;
}
