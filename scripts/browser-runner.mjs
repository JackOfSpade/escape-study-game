import { sha256 } from "./lib/digest.mjs";
import { docker, boundedText } from "./runner-process.mjs";
import {
  browserContainerOptions,
  browserLimits,
} from "./browser-container.mjs";
import { browserSpec, browserSpecText } from "./browser-runner/spec.mjs";
export async function executeReact(input, id) {
  const spec = browserSpec(input.code, input.steps),
    name = "study-browser-run-" + id,
    marker = "STUDY_REACT_" + id,
    startedAt = new Date().toISOString(),
    start = performance.now(),
    base = {
      id,
      language: "typescript",
      environment: "react",
      startedAt,
      codeHash: sha256(spec.code),
      specHash: sha256(browserSpecText(spec.code, spec.steps)),
      limits: { network: "none", hostMounts: false, ...browserLimits },
    };
  let imageId;
  try {
    const image = await docker([
      "image",
      "inspect",
      process.env.CODE_RUNNER_REACT_IMAGE ?? "study-browser-runtime:0.1.0",
      "--format",
      "{{.Id}}",
    ]);
    imageId = image.stdout.trim();
    if (image.exitCode !== 0 || !/^sha256:[a-f0-9]{64}$/.test(imageId))
      return {
        ...base,
        status: "unavailable",
        executed: false,
        detail: "Build the isolated React runtime image first; no code ran.",
      };
    const created = await docker([
      "create",
      ...browserContainerOptions(name),
      "-i",
      imageId,
      "timeout",
      "-s",
      "KILL",
      "14",
      "node",
      "/opt/study-browser/runner.mjs",
    ]);
    if (created.exitCode !== 0)
      return {
        ...base,
        imageId,
        status: "unavailable",
        executed: false,
        detail:
          "The isolated React container could not start; no learner code ran.",
      };
    const result = await docker(
        ["start", "--attach", "--interactive", name],
        JSON.stringify({ ...spec, marker }) + "\n",
        browserLimits.wallTimeMs,
        () => {
          void docker(["rm", "--force", name]);
        },
        browserLimits.outputBytes,
      ),
      executed = result.stderrPrefix.split("\n").includes(marker);
    let observed;
    try {
      observed = JSON.parse(result.stdout);
    } catch {
      /* Limits can interrupt a complete report. Keep raw bounded output. */
    }
    let preview;
    if (
      executed &&
      observed?.preview?.mimeType === "image/jpeg" &&
      typeof observed.preview.base64 === "string" &&
      observed.preview.base64.length <= 180000
    ) {
      const bytes = Buffer.from(observed.preview.base64, "base64");
      if (
        bytes.length > 4 &&
        bytes[0] === 255 &&
        bytes[1] === 216 &&
        bytes.at(-2) === 255 &&
        bytes.at(-1) === 217
      )
        preview = {
          dataUrl: "data:image/jpeg;base64," + bytes.toString("base64"),
          width: 640,
          height: 400,
          sha256: sha256(bytes),
        };
    }
    if (observed) delete observed.preview;
    const compileError = observed?.kind === "compile-error",
      status =
        result.reason ??
        (observed?.timedOut
          ? "timeout"
          : [124, 137, 152].includes(result.exitCode)
            ? "resource-limit"
            : !executed && !compileError
              ? "unavailable"
              : "completed");
    return {
      ...base,
      imageId,
      durationMs: Math.round(performance.now() - start),
      status,
      executed,
      exitCode: result.exitCode,
      stdout: boundedText(
        observed ? JSON.stringify(observed, null, 2) : result.stdout,
        browserLimits.outputBytes,
      ),
      stderr: boundedText(result.stderr.replace(marker + "\n", ""), 8192),
      ...(preview ? { preview } : {}),
      detail: compileError
        ? "TSX compilation failed; browser code was not executed."
        : !executed
          ? "Browser execution could not begin; no execution credit."
          : undefined,
    };
  } finally {
    await docker(["rm", "--force", name]);
  }
}
