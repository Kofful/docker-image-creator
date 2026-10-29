import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  // This scaffold deliberately does not load repository environment files.
  envDir: false,
  server: {
    proxy: { '/api': 'http://127.0.0.1:3000' },
  },
});
