import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { createApplicationRouter } from './router';
import { useUserStore } from './store/user';
import './assets/css/style.scss';

const application = createApp(App);
const pinia = createPinia();
const router = createApplicationRouter(pinia);
application.use(pinia);
application.use(router);

window.addEventListener('session-expired', () => {
  useUserStore(pinia).clear();
  if (router.currentRoute.value.path !== '/login') {
    void router.replace({ path: '/login', query: { expired: '1', redirect: router.currentRoute.value.fullPath } });
  }
});

void router.isReady().then(() => application.mount('#app'));
