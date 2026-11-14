/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { defineConfig } from "vite";

/** The app's version is the desktop app's: the dashboard ships inside it. Shown on About. */
const version = (JSON.parse(readFileSync(new URL("../desktop/package.json", import.meta.url), "utf8")) as { version: string }).version;

// In development the collector runs separately (npm run dev starts both);
// Vite proxies the API and the live feed to it, so the app uses relative URLs
// in both development and production.
const collector = process.env.RL_COLLECTOR ?? "http://localhost:49200";

export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(version) },
  server: {
    port: 5173,
    proxy: {
      "/api": collector,
      "/live": { target: collector.replace(/^http/, "ws"), ws: true },
    },
  },
  test: {
    name: "web",
    environment: "jsdom",
    include: ["src/**/*.test.tsx"],
    setupFiles: ["./src/test-setup.ts"],
  },
});
