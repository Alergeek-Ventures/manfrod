import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 20_000,
    env: { ENCRYPTION_KEY: "zO7HniI1WHaeX9V4TNxjaQkY4tKbwOLGXJPiASc4zAI=" },
  },
});
