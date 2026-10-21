import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Интеграционные тесты используют одну тестовую базу, поэтому файлы идут последовательно.
    fileParallelism: false,
    testTimeout: 20_000,
    // Проверки в браузере запускаются отдельно: npm run test:e2e.
    exclude: [...configDefaults.exclude, "test/e2e/**", ".claude/**"],
  },
});
