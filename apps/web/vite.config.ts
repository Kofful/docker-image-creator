import { defineConfig } from "vitest/config";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  // This scaffold deliberately does not load repository environment files.
  envDir: false,
  test: {
    environment: "jsdom",
    include: ["test/**/*.test.ts"],
    clearMocks: true,
    restoreMocks: true,
    unstubGlobals: true,
  },
  server: {
    proxy: { "/api": process.env.API_PROXY_TARGET ?? "http://127.0.0.1:3000" },
    watch: { usePolling: process.env.DEV_WATCH_POLLING === "true" },
  },
});
