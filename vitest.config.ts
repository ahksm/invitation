import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Интеграционные тесты используют одну тестовую базу, поэтому файлы идут последовательно.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
