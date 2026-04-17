import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    api: {
      host: '127.0.0.1',
    },
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
    },
  },
});
