import { defineConfig } from "@playwright/test";

// No persistent study bridge, existing server, real learner state or provider.
export default defineConfig({
  testDir: "./tests/browser",
  testMatch: [
    "game-test-lab.spec.ts",
    "keyboard-access.spec.ts",
    "pause-controls.spec.ts",
    "run-designer.spec.ts",
    "run-design-dressing.spec.ts",
    "authored-scene.spec.ts",
    "environment-surfaces.spec.ts",
  ],
  workers: 1,
  retries: 0,
  timeout: 30000,
  use: {
    baseURL: "http://127.0.0.1:5279",
    viewport: { width: 1440, height: 1000 },
    serviceWorkers: "block",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run client -- --port 5279 --strictPort",
    // Never reach the player's real study relay: a live run would ask real
    // Claude to prepare questions. Specs that need Claude mock /api themselves.
    env: { STUDY_BRIDGE_URL: "http://127.0.0.1:9" },
    url: "http://127.0.0.1:5279",
    reuseExistingServer: false,
  },
  reporter: [["list"], ["html", { open: "never" }]],
});
