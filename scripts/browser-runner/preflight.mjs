// Public synthetic counter only. This is not yet the learner-code execution API.
import { chromium } from "playwright";
import { build } from "esbuild";
import { readFileSync, existsSync } from "node:fs";
import { networkInterfaces as interfaces } from "node:os";
import { verifyBrowserSandbox } from "./sandbox.mjs";

const status = readFileSync("/proc/self/status", "utf8");
if (
  process.getuid() === 0 ||
  !/^NoNewPrivs:\s+1$/m.test(status) ||
  !/^CapEff:\s+0+$/m.test(status)
)
  throw Error(
    "Expected non-root, no new privileges and zero effective capabilities",
  );
const networkInterfaces = interfaces();
if (
  Object.keys(networkInterfaces).length !== 1 ||
  !networkInterfaces.lo?.every((a) => a.internal)
)
  throw Error("Only loopback may have an assigned network address");
const routes = readFileSync("/proc/net/route", "utf8")
  .trim()
  .split("\n")
  .slice(1);
if (routes.some((line) => line.trim().split(/\s+/)[0] !== "lo"))
  throw Error("No external route may exist");
const rootMount = readFileSync("/proc/self/mountinfo", "utf8")
  .split("\n")
  .map((line) => line.split(" "))
  .find((fields) => fields[4] === "/");
if (
  !rootMount?.[5].split(",").includes("ro") ||
  !/^Seccomp:\s+2$/m.test(status)
)
  throw Error("Expected actual read-only root and active outer seccomp");
if (existsSync("/var/run/docker.sock"))
  throw Error("Docker socket must not be available");
const browser = await chromium.launch({
  headless: true,
  channel: "chromium",
  chromiumSandbox: true,
  timeout: 8000,
});
try {
  const context = await browser.newContext({
    serviceWorkers: "block",
    acceptDownloads: false,
    viewport: { width: 640, height: 480 },
  });
  const page = await context.newPage();
  const sandbox = await verifyBrowserSandbox(page);
  console.log(
    JSON.stringify({
      phase: "sandbox",
      uid: process.getuid(),
      browser: browser.version(),
      sandbox,
      networkInterfaces,
      rootReadOnly: true,
      noNewPrivileges: true,
      effectiveCapabilities: "0",
      outerSeccomp: true,
      kernelLimits: {
        memory: readFileSync("/sys/fs/cgroup/memory.max", "utf8").trim(),
        pids: readFileSync("/sys/fs/cgroup/pids.max", "utf8").trim(),
        cpu: readFileSync("/sys/fs/cgroup/cpu.max", "utf8").trim(),
      },
    }),
  );
  const result = await build({
    stdin: {
      contents: `import {useState} from 'react';import {createRoot} from 'react-dom/client';function Counter(){const [n,setN]=useState(0);return <button onClick={()=>setN(n+1)}>Count {n}</button>}createRoot(document.getElementById('root')).render(<Counter/>);`,
      loader: "tsx",
      resolveDir: "/opt/study-browser",
    },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
  });
  await page.goto("about:blank");
  await page.setContent(
    '<!doctype html><meta charset="utf-8"><div id="root"></div>',
  );
  await page.addScriptTag({ content: result.outputFiles[0].text });
  await page.getByRole("button", { name: "Count 0", exact: true }).click();
  await page
    .getByRole("button", { name: "Count 1", exact: true })
    .waitFor({ state: "visible" });
  console.log(
    JSON.stringify({
      phase: "react",
      text: await page.locator("body").innerText(),
      react: JSON.parse(
        readFileSync(
          new URL("./node_modules/react/package.json", import.meta.url),
          "utf8",
        ),
      ).version,
      executed: true,
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      memoryEvents: readFileSync("/sys/fs/cgroup/memory.events", "utf8"),
    }),
  );
  throw error;
} finally {
  await browser.close();
}
