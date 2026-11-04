/**
 * The model the scoring service asks. Composition backs it with the Ollama plugin; tests use a fake.
 */

export type ScoringModelRequest = Readonly<{
  system: string;
  user: string;
  /** JSON schema the answer must follow. */
  schema: object;
  /** Overrides the default model for this call. */
  model?: string;
}>;

export type ScoringModelResult<T> = Readonly<{
  value: T;
  model: string;
  promptTokens: number;
  evalTokens: number;
  durationMs: number;
  attempts: number;
}>;

export interface ScoringModel {
  /** The model used when a run does not name one. */
  readonly defaultModel: string;
  /**
   * Throws ScoringModelUnavailableError when the model cannot answer at all (server down, timeout,
   * model not installed); any other error belongs to this one request.
   */
  chatJson<T>(request: ScoringModelRequest, parse: (content: string) => T): Promise<ScoringModelResult<T>>;
}

/** The model cannot answer any request: the run stops. */
export class ScoringModelUnavailableError extends Error {
  override name = 'ScoringModelUnavailableError';
}
