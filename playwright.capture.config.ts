/**
 * Manual-only capture driver. This suite plays the real game against the real
 * local study relay (real Claude CLI behind it), so it SPENDS REAL CLAUDE
 * USAGE and takes real wall-clock time. It requires the relay to be started
 * with ZOMBIE_AI_REPLAY_SAMPLES=1 so every bridge call's payload+answer lands
 * in the opt-in replay-sample store.
 *
 * Never part of `npm run test:browser` (that config owns ./tests/browser).
 * Run with: `npm run ai:capture -- study.capture.ts`.
 */
import { defineConfig } from "@playwright/test";

const port = Number(process.env.CAPTURE_PORT ?? "5279");
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw Error("CAPTURE_PORT must be an integer from 1 to 65535");

const minutes = Number(process.env.CAPTURE_TIMEOUT_MIN ?? "120");
if (!Number.isFinite(minutes) || minutes <= 0)
  throw Error("CAPTURE_TIMEOUT_MIN must be a positive number of minutes");

export default defineConfig({
  testDir: "./tests/ai-capture",
  testMatch: "**/*.capture.ts",
  // One live game at a time: several pages would compete for the same relay
  // and for CPU-bound WebGL frames.
  workers: 1,
  timeout: minutes * 60_000,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1440, height: 1000 },
    screenshot: "only-on-failure",
  },
  webServer: {
    command: `npm run client -- --port ${port} --strictPort`,
    // Deliberately no STUDY_BRIDGE_URL override: Vite proxies /api to the real
    // relay (http://127.0.0.1:4318 by default), which is the whole point.
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
  },
  reporter: "list",
});
