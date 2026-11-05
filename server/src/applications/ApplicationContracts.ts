/**
 * Ports of the applications domain. Composition backs ApplyAgent with plugins/claude-agent.ts and
 * ApplyBrowser with plugins/browser-lock.ts; tests pass fakes.
 */

export type ApplyAgentMode = 'fill' | 'submit';

export type AgentSpend = Readonly<{
  tokens: Readonly<{ input: number; cacheRead: number; output: number }>;
  costMicros: number;
}>;

export type ApplyAgentRequest = Readonly<{
  prompt: string;
  systemPrompt: string;
  schema: object;
  mode: ApplyAgentMode;
  resumeSessionId?: string;
  signal?: AbortSignal;
}>;

/** One tool call the guard saw; only the facts the domain needs. */
export type AgentToolCall = Readonly<{ tool: string; decision: 'allow' | 'deny'; reason?: string }>;

export type ApplyAgentResult = AgentSpend & Readonly<{
  /** The structured answer, not validated yet. */
  output: unknown;
  sessionId: string;
  turns: number;
  durationMs: number;
  toolCalls: AgentToolCall[];
  /** Where the run's files (system prompt, guard log) are kept. */
  runDir: string | null;
}>;

/** The agent failed (no `claude`, timeout, no answer); what it already spent is still counted. */
export class ApplyAgentError extends Error {
  override name = 'ApplyAgentError';
  constructor(
    message: string,
    readonly spend: AgentSpend,
    readonly details: Readonly<{ sessionId?: string; runDir?: string; toolCalls?: AgentToolCall[]; aborted?: boolean; unavailable?: boolean }> = {},
  ) {
    super(message);
  }
}

export interface ApplyAgent {
  run(request: ApplyAgentRequest): Promise<ApplyAgentResult>;
}

/** The shared agent Chromium: one task at a time. `acquire` throws when it is busy. */
export interface ApplyBrowser {
  acquire(task: string): Readonly<{ release(): void }>;
}

export type ApplySettings = Readonly<{
  /** Path of the CV copy the agent uploads (agentUploadPath of the plugin); null when not configured. */
  cvPath: string | null;
  /** APPLY_MAX_PER_RUN. */
  maxPerRun: number;
  /** APPLY_MAX_USD_PER_DAY in micro-dollars. */
  maxMicrosPerDay: number;
}>;
