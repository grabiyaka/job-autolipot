import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { ApiError, request } from '../src/mixin/fetch';
import { useUserStore, type SessionUser } from '../src/store/user';

vi.mock('../src/mixin/fetch', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/mixin/fetch')>(),
  request: vi.fn(),
}));

const manager: SessionUser = {
  id: 'user-1', email: 'admin@example.test', name: 'Менеджер', role: 'manager',
};

beforeEach(() => {
  setActivePinia(createPinia());
  vi.mocked(request).mockReset();
});

describe('user session', () => {
  it('restores a cookie session once and exposes manager capabilities', async () => {
    vi.mocked(request).mockResolvedValue({ user: manager });
    const store = useUserStore();

    await store.restore();
    await store.restore();

    expect(request).toHaveBeenCalledExactlyOnceWith('/api/auth/me', { anonymous: true });
    expect(store.user).toEqual(manager);
    expect(store.authenticated).toBe(true);
    expect(store.canManageTasks).toBe(true);
  });

  it('treats an expired cookie as an anonymous session', async () => {
    vi.mocked(request).mockRejectedValue(new ApiError(401, 'Сессия истекла.'));
    const store = useUserStore();

    await expect(store.restore()).resolves.toBeUndefined();
    expect(store.user).toBeNull();
    expect(store.restored).toBe(true);
    expect(store.authenticated).toBe(false);
    expect(store.canManageTasks).toBe(false);
  });

  it('keeps a failed connection retryable instead of claiming the user is logged out', async () => {
    const unavailable = new ApiError(0, 'Нет соединения.');
    vi.mocked(request).mockRejectedValueOnce(unavailable).mockResolvedValueOnce({ user: manager });
    const store = useUserStore();

    await expect(store.restore()).rejects.toBe(unavailable);
    expect(store.restored).toBe(false);
    await store.restore();
    expect(store.authenticated).toBe(true);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('sets the user only after login succeeds and sends the password only to login', async () => {
    vi.mocked(request).mockResolvedValue({ user: manager, expiresAt: '2030-01-01T00:00:00.000Z' });
    const store = useUserStore();

    await store.login(manager.email, 'test-password');

    expect(request).toHaveBeenCalledExactlyOnceWith('/api/auth/login', {
      method: 'POST', body: { email: manager.email, password: 'test-password' }, anonymous: true,
    });
    expect(store.user).toEqual(manager);
    expect(store.restored).toBe(true);
    expect(JSON.stringify(store.$state)).not.toContain('test-password');
    expect(store.$state).not.toHaveProperty('token');
  });

  it('does not authenticate on a rejected login', async () => {
    const forbidden = new ApiError(401, 'Неверный логин или пароль.');
    vi.mocked(request).mockRejectedValue(forbidden);
    const store = useUserStore();

    await expect(store.login(manager.email, 'wrong')).rejects.toBe(forbidden);
    expect(store.authenticated).toBe(false);
  });

  it('waits for server logout before clearing local session data', async () => {
    vi.mocked(request).mockResolvedValue(undefined);
    const store = useUserStore();
    store.user = manager;

    await store.logout();

    expect(request).toHaveBeenCalledExactlyOnceWith('/api/auth/logout', { method: 'POST' });
    expect(store.user).toBeNull();
    expect(store.authenticated).toBe(false);
    expect(store.restored).toBe(true);
  });

  it('keeps session state if the logout request could not reach the server', async () => {
    vi.mocked(request).mockRejectedValue(new ApiError(0, 'Нет соединения.'));
    const store = useUserStore();
    store.user = manager;

    await expect(store.logout()).rejects.toBeInstanceOf(ApiError);
    expect(store.authenticated).toBe(true);
  });

  it.each([
    { role: 'admin', label: 'Администратор', admin: true, general: true, guest: true },
    { role: 'manager', label: 'Менеджер', admin: false, general: true, guest: true },
    { role: 'guest', label: 'Гость', admin: false, general: false, guest: true },
    { role: 'foreign', label: 'Доступ не выдан', admin: false, general: false, guest: false },
  ] as const)('exposes only the capabilities granted to $role', ({ role, label, admin, general, guest }) => {
    const store = useUserStore();
    store.user = { ...manager, role };

    expect(store.authenticated).toBe(true);
    expect(store.roleLabel).toBe(label);
    expect(store.adminAccess).toBe(admin);
    expect(store.generalAccess).toBe(general);
    expect(store.guestAccess).toBe(guest);
    expect(store.canReadTasks).toBe(guest);
    expect(store.canManageTasks).toBe(general);
    expect(store.canDeleteTasks).toBe(admin);
  });

  it('does not grant any role capabilities without a session', () => {
    const store = useUserStore();

    expect(store.roleLabel).toBe('');
    expect(store.adminAccess).toBe(false);
    expect(store.generalAccess).toBe(false);
    expect(store.guestAccess).toBe(false);
    expect(store.canReadTasks).toBe(false);
    expect(store.canDeleteTasks).toBe(false);
  });
});
