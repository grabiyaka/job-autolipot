export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

type RequestOptions = Omit<RequestInit, 'body' | 'credentials'> & {
  body?: unknown;
  anonymous?: boolean;
};

export async function request<Result>(path: string, options: RequestOptions = {}): Promise<Result> {
  if (!path.startsWith('/api/')) throw new Error('API requests must use a local /api/ path.');
  const { body, anonymous, ...configuration } = options;
  const headers = new Headers(configuration.headers);
  headers.set('Accept', 'application/json');
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  if (!['GET', 'HEAD', 'OPTIONS'].includes((configuration.method ?? 'GET').toUpperCase())) {
    headers.set('X-Requested-With', 'XMLHttpRequest');
  }

  let response: Response;
  try {
    response = await fetch(path, {
      ...configuration,
      headers,
      credentials: 'same-origin',
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (error) {
    if (error && typeof error === 'object' && 'name' in error && error.name === 'AbortError') throw error;
    throw new ApiError(0, 'Не удалось связаться с сервером. Проверьте подключение и повторите попытку.');
  }

  if (!response.ok) {
    if (response.status === 401 && !anonymous) window.dispatchEvent(new Event('session-expired'));
    const content: unknown = await response.json().catch(() => null);
    const details = content && typeof content === 'object' && 'error' in content ? content.error : content;
    const message = details && typeof details === 'object' && 'message' in details && typeof details.message === 'string'
      ? details.message
      : 'Не удалось выполнить запрос. Попробуйте ещё раз.';
    throw new ApiError(response.status, message);
  }
  if (response.status === 204) return undefined as Result;
  return response.json() as Promise<Result>;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Произошла ошибка. Попробуйте ещё раз.';
}
