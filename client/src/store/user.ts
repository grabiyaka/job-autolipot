import { defineStore } from 'pinia';
import { ApiError, request } from '@/mixin/fetch';
import type { UserProfile } from '../../../server/src/users/UserTypes';

export type SessionUser = UserProfile;

const roleLabels: Readonly<Record<SessionUser['role'], string>> = {
  admin: 'Администратор',
  user: 'Пользователь',
};

export const useUserStore = defineStore('user', {
  state: () => ({ user: null as SessionUser | null, restored: false }),
  getters: {
    authenticated: (state) => state.user !== null,
    roleLabel: (state) => state.user ? roleLabels[state.user.role] : '',
    adminAccess: (state) => state.user?.role === 'admin',
  },
  actions: {
    clear() {
      this.user = null;
      this.restored = true;
    },
    async restore() {
      if (this.restored) return;
      try {
        const response = await request<{ user: SessionUser }>('/api/auth/me', { anonymous: true });
        this.user = response.user;
        this.restored = true;
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) this.clear();
        else throw error;
      }
    },
    async login(email: string, password: string) {
      const response = await request<{ user: SessionUser; expiresAt: string }>('/api/auth/login', {
        method: 'POST', body: { email, password }, anonymous: true,
      });
      this.user = response.user;
      this.restored = true;
    },
    async register(name: string, email: string, password: string) {
      const response = await request<{ user: SessionUser; expiresAt: string }>('/api/auth/register', {
        method: 'POST', body: { name, email, password }, anonymous: true,
      });
      this.user = response.user;
      this.restored = true;
    },
    async logout() {
      await request<void>('/api/auth/logout', { method: 'POST' });
      this.clear();
    },
  },
});
