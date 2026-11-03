import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, request } from '../src/mixin/fetch';

afterEach(() => vi.unstubAllGlobals());

describe('API requests', () => {
  it('sends JSON and the CSRF header with the same-origin session cookie', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'task-1' })));
    vi.stubGlobal('fetch', fetch);

    await expect(request('/api/tasks', {
      method: 'POST',
      body: { title: 'Проверить авторизацию' },
      headers: { 'X-Correlation-Id': 'request-1' },
    })).resolves.toEqual({ id: 'task-1' });

    const [path, options] = fetch.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(options.headers);
    expect(path).toBe('/api/tasks');
    expect(options.credentials).toBe('same-origin');
    expect(options.body).toBe(JSON.stringify({ title: 'Проверить авторизацию' }));
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(headers.get('Accept')).toBe('application/json');
    expect(headers.get('X-Requested-With')).toBe('XMLHttpRequest');
    expect(headers.get('X-Correlation-Id')).toBe('request-1');
    expect(headers.has('Authorization')).toBe(false);
  });

  it('does not parse an empty DELETE response as JSON', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetch);

    await expect(request('/api/tasks/task-1', { method: 'DELETE' })).resolves.toBeUndefined();
    const options = fetch.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(options.headers).get('X-Requested-With')).toBe('XMLHttpRequest');
    expect(options.body).toBeUndefined();
  });

  it.each(['https://example.com/api/tasks', '//example.com/api/tasks', '/tasks']) (
    'rejects requests outside the local API: %s', async (path) => {
      const fetch = vi.fn();
      vi.stubGlobal('fetch', fetch);

      await expect(request(path)).rejects.toThrow('local /api/ path');
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it('preserves an API error message and status for the UI', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: { code: 'FORBIDDEN', message: 'Нет доступа к этой операции.', requestId: 'request-1' } }), { status: 403 },
    )));

    await expect(request('/api/tasks')).rejects.toMatchObject({
      name: 'ApiError', status: 403, message: 'Нет доступа к этой операции.',
    });
  });

  it('provides a readable error when a gateway returns HTML', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<h1>Bad gateway</h1>', { status: 502 })));

    await expect(request('/api/tasks')).rejects.toMatchObject({
      name: 'ApiError', status: 502, message: expect.any(String),
    });
    await expect(request('/api/tasks')).rejects.not.toThrow('Unexpected token');
  });

  it('notifies the application when an authenticated session expires', async () => {
    const expired = vi.fn();
    window.addEventListener('session-expired', expired);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 401 })));
    try {
      await expect(request('/api/tasks')).rejects.toBeInstanceOf(ApiError);
      expect(expired).toHaveBeenCalledOnce();
    } finally {
      window.removeEventListener('session-expired', expired);
    }
  });

  it('does not emit session-expired for an incorrect login password', async () => {
    const expired = vi.fn();
    window.addEventListener('session-expired', expired);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 401 })));
    try {
      await expect(request('/api/auth/login', {
        method: 'POST', body: { email: 'admin@example.test', password: 'incorrect' }, anonymous: true,
      })).rejects.toBeInstanceOf(ApiError);
      expect(expired).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('session-expired', expired);
    }
  });

  it('distinguishes a connection failure from a deliberate cancellation', async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetch);
    await expect(request('/api/tasks')).rejects.toMatchObject({ name: 'ApiError', status: 0 });

    const abort = new DOMException('Request was cancelled', 'AbortError');
    fetch.mockRejectedValueOnce(abort);
    await expect(request('/api/tasks')).rejects.toBe(abort);
  });
});
