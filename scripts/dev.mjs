import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { ensureBridge } from "./bridge-service.mjs";

export async function startDev({
  bridgeOptions = {},
  clientEntry = fileURLToPath(
    new URL("../node_modules/vite/bin/vite.js", import.meta.url),
  ),
  clientArgs = ["--host", "127.0.0.1"],
} = {}) {
  const bridge = await ensureBridge(bridgeOptions);
  console.log(
    `Study bridge ${bridge.reused ? "reconnected" : "started"}: http://127.0.0.1:${bridgeOptions.port ?? 4318} (persists across dev-server restarts)`,
  );
  const vite = spawn(process.execPath, [clientEntry, ...clientArgs], {
    stdio: "inherit",
  });
  let closing = false;
  function close(signal = "SIGTERM") {
    if (closing) return;
    closing = true;
    vite.kill(signal);
  }
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => close(signal));
  vite.once("error", (error) => {
    console.error(error.message);
    process.exit(1);
  });
  vite.once("exit", (code) => {
    console.log(
      "Dev server stopped. Study bridge remains running; npm run bridge:stop ends it.",
    );
    process.exit(code ?? 0);
  });
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await startDev();
