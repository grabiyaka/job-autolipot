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
      store.user = { id: 'user-1', email: 'admin@example.test', name: 'Пользователь', role: 'user' };
      store.restored = true;
    });

    await router.push('/profile');

    expect(router.currentRoute.value.path).toBe('/profile');
    expect(store.restore).toHaveBeenCalled();
  });

  it('does not navigate an authenticated user to an external login redirect', async () => {
    const store = useUserStore(pinia);
    store.user = { id: 'user-1', email: 'admin@example.test', name: 'Пользователь', role: 'user' };
    store.restored = true;

    await router.push({ path: '/login', query: { redirect: 'https://example.com/phishing' } });

    expect(router.currentRoute.value.path).toBe('/jobs');
  });

  it('shows server unavailability at login while preserving the destination', async () => {
    const store = useUserStore(pinia);
    vi.spyOn(store, 'restore').mockRejectedValue(new Error('Connection refused'));

    await router.push('/profile');

    expect(router.currentRoute.value.path).toBe('/login');
    expect(router.currentRoute.value.query).toMatchObject({ unavailable: '1', redirect: '/profile' });
  });

  it('keeps registration public and sends an authenticated visitor away from it', async () => {
    const store = useUserStore(pinia);
    store.clear();
    await router.push('/register');
    expect(router.currentRoute.value.path).toBe('/register');

    store.user = { id: 'user-1', email: 'user@example.test', name: 'Пользователь', role: 'user' };
    await router.push('/login');
    await router.push('/register');
    expect(router.currentRoute.value.path).toBe('/jobs');
  });
});

describe('safe post-login destinations', () => {
  it.each(['/jobs', '/profile', '/jobs?page=2', '/profile#account'])(
    'keeps an allowed application route: %s', (path) => expect(safeRedirect(path)).toBe(path),
  );

  it.each([
    'https://example.com', '//example.com', '/\\example.com', 'javascript:alert(1)',
    '/login', '/api/auth/logout', '/profile/../../login', ['/profile'], undefined, null,
  ])('falls back to jobs for an untrusted destination: %s', (path) => {
    expect(safeRedirect(path)).toBe('/jobs');
  });
});
