import type { Page } from "@playwright/test";
// @ts-expect-error Local execution-only server with no model provider.
import { createStudyBridgeServer } from "../../../scripts/study-bridge-server.mjs";
import type { Server } from "node:http";

/** Exercise the real local runner without releasing study/model requests. */
export async function isolateRunnerBridge(page: Page, executionBase?: string) {
  if (!executionBase) {
    const server: Server = createStudyBridgeServer();
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw Error("No isolated execution server");
    executionBase = `http://127.0.0.1:${address.port}`;
    page.once("close", () => {
      server.closeAllConnections();
      server.close();
    });
  }
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/execute") {
      const response = await fetch(`${executionBase}/api/execute`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://127.0.0.1:5173",
        },
        body: route.request().postData()!,
      });
      return route.fulfill({
        status: response.status,
        contentType: "application/json",
        body: await response.text(),
      });
    }
    if (path === "/api/status")
      return route.fulfill({
        json: {
          mode: "development",
          label: "Synthetic runner fixture",
          capabilities: [],
          detail: "Only the local restricted execution route is connected.",
        },
      });
    return route.fulfill({
      status: 503,
      json: { error: "Study requests are isolated in this runner fixture" },
    });
  });
}
