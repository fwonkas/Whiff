import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          include: ["**/test/**/*.test.ts"],
          exclude: ["**/node_modules/**"],
          testTimeout: 30_000,
          // Some suites ingest every fixture up front; slow CI runners need longer than the 10 s default.
          hookTimeout: 60_000,
        },
      },
      // The web app has its own config: React plugin and jsdom.
      "apps/web/vite.config.ts",
    ],
  },
});
