/**
 * Client of a local Ollama server (POST /api/chat) that asks for one JSON answer.
 *
 * One call = one non-streaming request with thinking off, `format` set to the caller's JSON schema
 * and temperature 0. Context size and output length are sent per request; the Ollama server config
 * is not touched. The client knows nothing about the subject of the prompt.
 *
 * Ollama does not fail a prompt that is longer than num_ctx: it silently cuts it, which can drop the
 * system rules. So an answer whose prompt left no room for the full output
 * (prompt_eval_count > num_ctx − num_predict) is rejected, as is any answer that did not finish
 * normally (done_reason other than "stop").
 */

export type OllamaConfig = Readonly<{
  baseUrl: string;
  model: string;
  numCtx: number;
  /** Output limit; the JSON answer is a few hundred tokens. */
  numPredict: number;
  timeoutMs: number;
}>;

export type ChatJsonRequest = Readonly<{
  system: string;
  user: string;
  /** JSON schema passed as Ollama `format`. */
  schema: object;
  /** Overrides the configured model for this call. */
  model?: string;
}>;

export type ChatJsonResult<T> = Readonly<{
  value: T;
  model: string;
  promptTokens: number;
  evalTokens: number;
  durationMs: number;
  /** 1, or 2 when the first answer did not parse. */
  attempts: number;
}>;

export type OllamaClient = Readonly<{
  config: OllamaConfig;
  chatJson<T>(request: ChatJsonRequest, parse: (content: string) => T): Promise<ChatJsonResult<T>>;
}>;

export class OllamaError extends Error {
  override name = 'OllamaError';
}
/** Ollama cannot be reached (refused, DNS, timeout): the caller stops the whole run. */
export class OllamaUnavailableError extends OllamaError {
  override name = 'OllamaUnavailableError';
}
/** Ollama answered with an HTTP error, e.g. 404 when the model is not pulled. */
export class OllamaHttpError extends OllamaError {
  override name = 'OllamaHttpError';
  constructor(readonly status: number, message: string) {
    super(message);
  }
}
/** The answer is incomplete, the prompt was cut, or the content did not parse twice in a row. */
export class OllamaResponseError extends OllamaError {
  override name = 'OllamaResponseError';
}

export const defaultOllamaConfig: OllamaConfig = {
  baseUrl: 'http://127.0.0.1:11434',
  model: 'qwen3.5:4b',
  numCtx: 8192,
  numPredict: 1024,
  timeoutMs: 120_000,
};

const snippetChars = 300;
const snippet = (text: string) => (text.length > snippetChars ? `${text.slice(0, snippetChars)}…` : text);

type ChatResponse = Readonly<{
  model?: unknown;
  done?: unknown;
  done_reason?: unknown;
  prompt_eval_count?: unknown;
  eval_count?: unknown;
  message?: { role?: unknown; content?: unknown };
}>;

type Answer = Readonly<{ content: string; model: string; promptTokens: number; evalTokens: number }>;

export function createOllamaClient(config: OllamaConfig): OllamaClient {
  if (!/^https?:\/\//.test(config.baseUrl)) throw new Error(`OLLAMA_URL должен быть http(s) URL, получено "${config.baseUrl}"`);
  if (!config.model) throw new Error('Модель Ollama не задана');
  if (!(config.numCtx > config.numPredict && config.numPredict > 0)) {
    throw new Error(`num_ctx (${config.numCtx}) должен быть больше num_predict (${config.numPredict})`);
  }
  if (!(config.timeoutMs > 0)) throw new Error('Таймаут Ollama должен быть положительным');
  const url = `${config.baseUrl.replace(/\/+$/, '')}/api/chat`;

  async function post(body: object): Promise<ChatResponse> {
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(config.timeoutMs),
      });
    } catch (error) {
      const reason = error instanceof Error && error.name === 'TimeoutError'
        ? `нет ответа за ${config.timeoutMs} мс`
        : error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : String(error);
      throw new OllamaUnavailableError(`Ollama ${url} недоступна: ${reason}`);
    }
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      throw new OllamaUnavailableError(`Ollama ${url}: ответ оборвался: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) throw new OllamaHttpError(response.status, `Ollama HTTP ${response.status}: ${httpErrorMessage(text)}`);
    try {
      const data: unknown = JSON.parse(text);
      if (typeof data === 'object' && data !== null && !Array.isArray(data)) return data as ChatResponse;
    } catch { /* reported below */ }
    throw new OllamaResponseError(`Ollama вернула не JSON-объект: ${snippet(text)}`);
  }

  function answer(response: ChatResponse, model: string): Answer {
    if (response.done !== true) throw new OllamaResponseError('Ollama: ответ не завершён (done != true)');
    if (response.done_reason !== 'stop') {
      throw new OllamaResponseError(`Ollama: ответ оборван, done_reason "${String(response.done_reason)}"`);
    }
    const promptTokens = typeof response.prompt_eval_count === 'number' ? response.prompt_eval_count : 0;
    const promptLimit = config.numCtx - config.numPredict;
    if (promptTokens > promptLimit) {
      throw new OllamaResponseError(
        `Ollama: промпт занял ${promptTokens} токенов при пределе ${promptLimit} (num_ctx ${config.numCtx}); вероятно, он обрезан`,
      );
    }
    const message = response.message;
    if (message?.role !== 'assistant' || typeof message.content !== 'string') {
      throw new OllamaResponseError('Ollama: в ответе нет сообщения assistant со строкой');
    }
    return {
      content: message.content,
      model: typeof response.model === 'string' ? response.model : model,
      promptTokens,
      evalTokens: typeof response.eval_count === 'number' ? response.eval_count : 0,
    };
  }

  return {
    config,
    async chatJson<T>(request: ChatJsonRequest, parse: (content: string) => T): Promise<ChatJsonResult<T>> {
      const model = request.model ?? config.model;
      const body = {
        model,
        messages: [{ role: 'system', content: request.system }, { role: 'user', content: request.user }],
        format: request.schema,
        stream: false,
        think: false,
        options: { num_ctx: config.numCtx, num_predict: config.numPredict, temperature: 0 },
      };
      const started = performance.now();
      let promptTokens = 0;
      let evalTokens = 0;
      for (let attempt = 1; ; attempt++) {
        const reply = answer(await post(body), model);
        promptTokens += reply.promptTokens;
        evalTokens += reply.evalTokens;
        try {
          const value = parse(reply.content);
          return { value, model: reply.model, promptTokens, evalTokens, durationMs: Math.round(performance.now() - started), attempts: attempt };
        } catch (error) {
          if (attempt >= 2) {
            const reason = error instanceof Error ? error.message : String(error);
            throw new OllamaResponseError(`Ollama: ответ не разобран после повтора (${reason}): ${snippet(reply.content)}`);
          }
        }
      }
    },
  };
}

function httpErrorMessage(text: string): string {
  try {
    const data: unknown = JSON.parse(text);
    if (typeof data === 'object' && data !== null && typeof (data as { error?: unknown }).error === 'string') {
      return snippet((data as { error: string }).error);
    }
  } catch { /* plain text body */ }
  return snippet(text);
}
