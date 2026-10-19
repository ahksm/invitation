import { defineConfig } from "vitest/config";

// Проверки в браузере (npm run test:e2e): отдельно от основных тестов, им нужен Chromium.
export default defineConfig({
  test: {
    include: ["test/e2e/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
