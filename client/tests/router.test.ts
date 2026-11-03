import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, type Pinia } from 'pinia';
import type { Router } from 'vue-router';
import { createApplicationRouter, safeRedirect } from '../src/router';
import { useUserStore } from '../src/store/user';

vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-router')>();
  return { ...actual, createWebHistory: actual.createMemoryHistory };
});

let pinia: Pinia;
let router: Router;

beforeEach(() => {
  pinia = createPinia();
  router = createApplicationRouter(pinia);
});

afterEach(() => router.options.history.destroy());

describe('session navigation', () => {
  it('returns an anonymous visitor to login with the original internal route', async () => {
    const store = useUserStore(pinia);
    store.clear();

    await router.push('/profile?tab=security');

    expect(router.currentRoute.value.path).toBe('/login');
    expect(router.currentRoute.value.query.redirect).toBe('/profile?tab=security');
  });

  it('restores the existing session before deciding whether a page is accessible', async () => {
    const store = useUserStore(pinia);
    vi.spyOn(store, 'restore').mockImplementation(async () => {
      store.user = { id: 'user-1', email: 'admin@example.test', name: 'Менеджер', role: 'manager' };
      store.restored = true;
    });

    await router.push('/profile');

    expect(router.currentRoute.value.path).toBe('/profile');
    expect(store.restore).toHaveBeenCalled();
  });

  it('does not navigate an authenticated user to an external login redirect', async () => {
    const store = useUserStore(pinia);
    store.user = { id: 'user-1', email: 'admin@example.test', name: 'Менеджер', role: 'manager' };
    store.restored = true;

    await router.push({ path: '/login', query: { redirect: 'https://example.com/phishing' } });

    expect(router.currentRoute.value.path).toBe('/tasks');
  });

  it('shows server unavailability at login while preserving the destination', async () => {
    const store = useUserStore(pinia);
    vi.spyOn(store, 'restore').mockRejectedValue(new Error('Connection refused'));

    await router.push('/profile');

    expect(router.currentRoute.value.path).toBe('/login');
    expect(router.currentRoute.value.query).toMatchObject({ unavailable: '1', redirect: '/profile' });
  });

  it('keeps the profile accessible before a foreign user receives application access', async () => {
    const store = useUserStore(pinia);
    store.user = { id: 'user-1', email: 'user@example.test', name: 'Пользователь', role: 'foreign' };
    store.restored = true;

    await router.push('/profile');

    expect(router.currentRoute.value.path).toBe('/profile');
    expect(store.authenticated).toBe(true);
  });
});

describe('safe post-login destinations', () => {
  it.each(['/tasks', '/profile', '/tasks?page=2', '/profile#account'])(
    'keeps an allowed application route: %s', (path) => expect(safeRedirect(path)).toBe(path),
  );

  it.each([
    'https://example.com', '//example.com', '/\\example.com', 'javascript:alert(1)',
    '/login', '/api/auth/logout', '/profile/../../login', ['/profile'], undefined, null,
  ])('falls back to tasks for an untrusted destination: %s', (path) => {
    expect(safeRedirect(path)).toBe('/tasks');
  });
});
