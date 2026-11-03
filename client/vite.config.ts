import { fileURLToPath, URL } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [vue()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:3400' },
      '/docs': { target: 'http://127.0.0.1:3400' },
    },
  },
  css: {
    preprocessorOptions: {
      scss: { additionalData: '@use "@/assets/css/common.scss" as *;\n' },
    },
  },
  test: { environment: 'jsdom', clearMocks: true, restoreMocks: true },
});
