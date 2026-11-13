import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@life/shared": r("./packages/shared/src/index.ts"),
      "@life/domain": r("./packages/domain/src/index.ts"),
      "@life/llm": r("./packages/llm/src/index.ts"),
      "@life/channels": r("./packages/channels/src/index.ts"),
      "@life/planning": r("./packages/planning/src/index.ts"),
      "@life/db": r("./packages/db/src/index.ts"),
    },
  },
  test: {
    include: ["packages/*/tests/**/*.test.ts"],
    environment: "node",
    passWithNoTests: false,
  },
});
