import { createRouter, createWebHistory } from 'vue-router';
import type { Pinia } from 'pinia';
import { useUserStore } from '@/store/user';
import LoginPage from '@/components/user/LoginPage.vue';
import JobList from '@/components/jobs/JobList.vue';
import ProfilePage from '@/components/user/ProfilePage.vue';

export function safeRedirect(value: unknown): string {
  return typeof value === 'string' && /^\/(?:jobs|profile)(?:[?#].*)?$/.test(value)
    ? value
    : '/jobs';
}

export function createApplicationRouter(pinia: Pinia) {
  const router = createRouter({
    history: createWebHistory(),
    routes: [
      { path: '/', redirect: '/jobs' },
      { path: '/login', component: LoginPage, meta: { public: true, title: 'Вход' } },
      { path: '/register', component: LoginPage, meta: { public: true, title: 'Регистрация' } },
      { path: '/jobs', component: JobList, meta: { title: 'Вакансии' } },
      { path: '/profile', component: ProfilePage, meta: { title: 'Профиль' } },
      { path: '/:pathMatch(.*)*', redirect: '/jobs' },
    ],
  });

  router.beforeEach(async (to) => {
    const user = useUserStore(pinia);
    try {
      await user.restore();
    } catch {
      if (!to.meta.public) return { path: '/login', query: { unavailable: '1', redirect: to.fullPath } };
    }
    if (!to.meta.public && !user.authenticated) return { path: '/login', query: { redirect: to.fullPath } };
    if (to.meta.public && user.authenticated) return safeRedirect(to.query.redirect);
  });
  router.afterEach((to) => { document.title = `${String(to.meta.title ?? 'Рабочее пространство')} · job-autopilot`; });
  return router;
}
