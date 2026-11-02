import { checkBridge } from "../../src/ai";
/** Explicit synthetic verdict transport for mechanics-only tests, never a production fallback. */
export async function withCompletionProvider<T>(
  run: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url) === "/api/status")
      return Response.json({
        mode: "claude-cli",
        label: "Synthetic completion fixture",
        detail: "No external AI request",
        capabilities: ["complete"],
      });
    const body = JSON.parse(String(init?.body));
    if (body.operation !== "complete")
      throw Error(`Unexpected synthetic operation ${body.operation}`);
    return Response.json({
      complete: true,
      feedback:
        "Accepted by explicit synthetic fixture; not model quality evidence",
      qualified: ["human"],
    });
  };
  await checkBridge();
  try {
    return await run();
  } finally {
    globalThis.fetch = async () =>
      Response.json({
        mode: "development",
        label: "Disconnected",
        detail: "Fixture restored",
        capabilities: [],
      });
    await checkBridge();
    globalThis.fetch = original;
  }
}
