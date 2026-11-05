import { defineConfig } from "@playwright/test";
// Tests import source modules directly. Reusing a production server can serve
// a stale bundle and 404 those imports, so own an isolated Vite instance.
const port = Number(process.env.GAME_TEST_PORT ?? "5278");
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw Error("GAME_TEST_PORT must be an integer from 1 to 65535");
export default defineConfig({
  testDir: "./tests/browser",
  // Live keyboard/RAF survival cases model one player. Competing game pages
  // delay controller input independently of simulation and can exhaust cover.
  workers: 1,
  timeout: 30000,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1440, height: 1000 },
    screenshot: "only-on-failure",
  },
  webServer: {
    command: `npm run client -- --port ${port} --strictPort`,
    // Never reach the player's real study relay: a live run would ask real
    // Claude to prepare questions. Specs that need Claude mock /api themselves.
    env: { STUDY_BRIDGE_URL: "http://127.0.0.1:9" },
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
  },
  reporter: "list",
});
