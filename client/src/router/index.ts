import { createRouter, createWebHistory } from 'vue-router';
import type { Pinia } from 'pinia';
import { useUserStore } from '@/store/user';
import LoginPage from '@/components/user/LoginPage.vue';
import TaskList from '@/components/tasks/TaskList.vue';
import ProfilePage from '@/components/user/ProfilePage.vue';

export function safeRedirect(value: unknown): string {
  return typeof value === 'string' && /^\/(?:tasks|profile)(?:[?#].*)?$/.test(value)
    ? value
    : '/tasks';
}

export function createApplicationRouter(pinia: Pinia) {
  const router = createRouter({
    history: createWebHistory(),
    routes: [
      { path: '/', redirect: '/tasks' },
      { path: '/login', component: LoginPage, meta: { public: true, title: 'Вход' } },
      { path: '/tasks', component: TaskList, meta: { title: 'Задачи' } },
      { path: '/profile', component: ProfilePage, meta: { title: 'Профиль' } },
      { path: '/:pathMatch(.*)*', redirect: '/tasks' },
    ],
  });

  router.beforeEach(async (to) => {
    const user = useUserStore(pinia);
    try {
      await user.restore();
    } catch {
      if (to.path !== '/login') return { path: '/login', query: { unavailable: '1', redirect: to.fullPath } };
    }
    if (!to.meta.public && !user.authenticated) return { path: '/login', query: { redirect: to.fullPath } };
    if (to.path === '/login' && user.authenticated) return safeRedirect(to.query.redirect);
  });
  router.afterEach((to) => { document.title = `${String(to.meta.title ?? 'Рабочее пространство')} · JWX`; });
  return router;
}
