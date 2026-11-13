import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "eval/tests/**/*.test.ts"],
  },
});
