import { defineConfig } from "vitest/config";

const eveDynamicToolTransform = new URL("./node_modules/eve/dist/src/internal/workflow-bundle/dynamic-tool-transform.js", import.meta.url)
  .href;

const eveDynamicTools = {
  name: "eve-dynamic-tools",
  async transform(code: string, id: string) {
    const path = id.split("?")[0];
    if (!path.includes("/agent/") || !code.includes("defineDynamic")) return null;
    const { transformDynamicToolExecute } = await import(eveDynamicToolTransform);
    const out = await transformDynamicToolExecute(path, code);
    return out ? { code: out.code as string, map: null } : null;
  },
};

export default defineConfig({
  plugins: [eveDynamicTools],
  test: {
    include: ["test/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 20_000,
    env: { ENCRYPTION_KEY: "zO7HniI1WHaeX9V4TNxjaQkY4tKbwOLGXJPiASc4zAI=" },
  },
});
