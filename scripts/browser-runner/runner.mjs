import { readPacket } from "./packet.mjs";
import { createSandboxedExercise } from "./sandbox.mjs";
import { compileAndRelease } from "./compile.mjs";
// Trusted controller inside the isolated container. Learner code runs only in Chromium.
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { browserSpec } from "./spec.mjs";
const require = createRequire(import.meta.url),
  startedAt = Date.now();
let input, spec;
const result = {
  schema: 1,
  environment: "react",
  compiled: false,
  interactionProvenance:
    "Automated issued task checks; not human-authored tests or manual browser interaction.",
  browserVersion: "",
  reactVersion: "",
  console: [],
  errors: [],
  steps: [],
  blockedRequests: [],
  domText: "",
  timedOut: false,
  phase: "initializing",
  phases: [],
};
let executed = false,
  emitted = false,
  consoleBytes = 0;
function phase(name) {
  result.phase = name;
  result.phases.push({ name, elapsedMs: Date.now() - startedAt });
}
function short(value, n = 1000) {
  return String(value).slice(0, n);
}
async function emit(exitCode = 0) {
  if (emitted) return;
  emitted = true;
  result.durationMs = Date.now() - startedAt;
  await new Promise((resolve, reject) =>
    process.stdout.write(JSON.stringify(result), (error) =>
      error ? reject(error) : resolve(),
    ),
  );
  process.exitCode = exitCode;
}
const deadline = setTimeout(async () => {
  result.timedOut = true;
  result.errors.push("Browser execution reached its 12-second wall limit.");
  await emit(124);
  process.exit(124);
}, 12000);
let browser;
let bootstrapResources;
const kernelSnapshot = () =>
  Object.fromEntries(
    [
      "cpu.stat",
      "memory.events",
      "memory.current",
      "memory.stat",
      "pids.current",
    ].map((file) => {
      try {
        return [
          file,
          readFileSync("/sys/fs/cgroup/" + file, "utf8")
            .trim()
            .slice(0, 8000),
        ];
      } catch {
        return [file, "unavailable"];
      }
    }),
  );
try {
  phase("reading-packet");
  input = JSON.parse(await readPacket(process.stdin));
  spec = browserSpec(input.code, input.steps);
  if (
    typeof input.marker !== "string" ||
    !/^STUDY_REACT_[a-z0-9-]{20,60}$/.test(input.marker)
  )
    throw Error("Missing execution marker");
  phase("loading-runtime");
  const [{ chromium }, compiler] = await Promise.all([
    import("playwright"),
    import("esbuild"),
  ]);
  result.reactVersion = require("react/package.json").version;
  phase("writing-component");
  writeFileSync("/work/Component.tsx", spec.code);
  const allowed = new Set([
    "react",
    "react-dom",
    "react-dom/client",
    "react/jsx-runtime",
    "react/jsx-dev-runtime",
  ]);
  phase("compiling");
  const bundled = await compileAndRelease(
    () =>
      compiler.build({
        stdin: {
          contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';import App from '/work/Component.tsx';flushSync(()=>createRoot(document.getElementById('root')).render(<App/>));`,
          loader: "tsx",
          resolveDir: "/opt/study-browser",
        },
        bundle: true,
        write: false,
        platform: "browser",
        format: "iife",
        jsx: "automatic",
        logLevel: "silent",
        plugins: [
          {
            name: "single-react-module",
            setup(build) {
              build.onResolve({ filter: /.*/ }, (args) => {
                if (args.importer === "/work/Component.tsx") {
                  if (!allowed.has(args.path))
                    return {
                      errors: [
                        {
                          text: "Only installed React imports are available; this runtime accepts a single TSX module.",
                        },
                      ],
                    };
                  return { path: require.resolve(args.path) };
                }
                return undefined;
              });
            },
          },
        ],
      }),
    () => compiler.stop(),
  );
  result.compiled = true;
  phase("launching-browser");
  bootstrapResources = kernelSnapshot();
  browser = await chromium.launch({
    headless: true,
    channel: "chromium",
    chromiumSandbox: true,
    timeout: 7000,
  });
  result.browserVersion = browser.version();
  const { context, page } = await createSandboxedExercise(browser, phase);
  result.sandboxVerified = true;
  context.on("page", (popup) => {
    if (popup !== page) void popup.close();
  });
  page.on("dialog", (dialog) => {
    result.errors.push(short(`Dismissed page dialog: ${dialog.message()}`));
    void dialog.dismiss();
  });
  page.on("console", (message) => {
    const text = message.text();
    if (text === input.marker) {
      if (!executed) {
        executed = true;
        result.executionBeganMs = Date.now() - startedAt;
        process.stderr.write(input.marker + "\n");
      }
      return;
    }
    if (result.console.length < 40 && consoleBytes < 8000) {
      const item = { type: message.type(), text: short(text, 1000) };
      consoleBytes += item.text.length;
      result.console.push(item);
    }
  });
  page.on("pageerror", (error) => {
    if (result.errors.length < 20) result.errors.push(short(error.message));
  });
  const html =
      '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Isolated React exercise</title><style>body{margin:16px;font:16px system-ui;background:#fff;color:#111}</style></head><body><div id="root"></div><script src="/component.js"></script></body></html>',
    script = `console.debug(${JSON.stringify(input.marker)});\n${bundled.outputFiles[0].text}`;
  phase("installing-offline-route");
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (
      url.origin === "http://exercise.invalid" &&
      route.request().method() === "GET" &&
      (url.pathname === "/" || url.pathname === "/component.js")
    ) {
      await route.fulfill({
        status: 200,
        contentType: url.pathname === "/" ? "text/html" : "text/javascript",
        headers: {
          "Content-Security-Policy":
            "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
          "Cache-Control": "no-store",
        },
        body: url.pathname === "/" ? html : script,
      });
    } else {
      if (result.blockedRequests.length < 20)
        result.blockedRequests.push(short(route.request().url(), 200));
      await route.abort("blockedbyclient");
    }
  });
  phase("loading-exercise");
  await page.goto("http://exercise.invalid/", { waitUntil: "load" });
  phase("running-checks");
  for (const step of spec.steps) {
    const entry = { ...step, passed: false },
      locator = page.locator("css=" + step.selector);
    try {
      if (step.kind === "click") await locator.click();
      if (step.kind === "fill") await locator.fill(step.value);
      if (step.kind === "press") await locator.press(step.key);
      if (step.kind === "expect-text" || step.kind === "expect-count") {
        const end = Date.now() + 800;
        do {
          if (step.kind === "expect-text") {
            await locator.waitFor({ state: "visible" });
            entry.observed = short((await locator.innerText()).trim(), 2000);
            if (entry.observed === step.text) {
              entry.passed = true;
              break;
            }
          } else {
            entry.observed = await locator.count();
            if (entry.observed === step.count) {
              entry.passed = true;
              break;
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        } while (Date.now() < end);
        if (!entry.passed) throw Error("Observed DOM did not match this check");
      } else entry.passed = true;
    } catch (error) {
      entry.error = short(error.message);
      result.steps.push(entry);
      break;
    }
    result.steps.push(entry);
  }
  phase("reading-dom");
  result.domText = short(await page.locator("body").innerText(), 8000);
  phase("capturing-preview");
  let screenshot = await page.screenshot({
    type: "jpeg",
    quality: 55,
    timeout: 1500,
  });
  if (screenshot.length > 135000)
    screenshot = await page.screenshot({
      type: "jpeg",
      quality: 25,
      timeout: 1500,
    });
  if (screenshot.length <= 135000)
    result.preview = {
      mimeType: "image/jpeg",
      width: 640,
      height: 400,
      base64: screenshot.toString("base64"),
    };
  phase("finished");
  await emit(
    result.errors.length || result.steps.some((s) => !s.passed) ? 1 : 0,
  );
} catch (error) {
  if (result.compiled && !executed)
    result.bootstrapResources = {
      before: bootstrapResources,
      after: kernelSnapshot(),
    };
  if (error.name === "TimeoutError") result.timedOut = true;
  result.errors.push(short(error.message, 2000));
  result.kind =
    result.phase === "compiling" && !result.compiled
      ? "compile-error"
      : executed
        ? "runtime-error"
        : "environment-error";
  await emit(1);
} finally {
  clearTimeout(deadline);
  await browser?.close();
}
