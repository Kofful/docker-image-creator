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
    proxy: { "/api": "http://127.0.0.1:3000" },
  },
});
