import {
  codePacket,
  pythonBootstrap,
  nodeBootstrap,
} from "./runner-bootstrap.mjs";
import { docker, boundedText, maxOutput } from "./runner-process.mjs";
import { executeReact } from "./browser-runner.mjs";
import { browserSpec } from "./browser-runner/spec.mjs";
import { randomUUID } from "node:crypto";
import { sha256 } from "./lib/digest.mjs";

const images = {
  python: process.env.CODE_RUNNER_PYTHON_IMAGE ?? "python:3.12-alpine",
  typescript: process.env.CODE_RUNNER_NODE_IMAGE ?? "node:22",
  javascript: process.env.CODE_RUNNER_NODE_IMAGE ?? "node:22",
};
let active = false;
/** No host mounts, shell interpolation, network, or inherited host credentials. */
export async function executeCode(input) {
  if (
    !input ||
    !Object.hasOwn(images, input.language) ||
    typeof input.code !== "string" ||
    Buffer.byteLength(input.code, "utf8") > 65536
  )
    throw Error("Expected Python, TypeScript or JavaScript code up to 64 KiB");
  if (input.environment !== undefined && input.environment !== "react")
    throw Error("Unsupported execution environment");
  if (input.environment === "react" && input.language !== "typescript")
    throw Error("React execution requires TypeScript/TSX");
  const react =
    input.environment === "react"
      ? browserSpec(input.code, input.steps)
      : undefined;
  if (active) throw Error("Runner busy; retry when the current run finishes");
  active = true;
  const id = randomUUID(),
    name = `study-code-${id}`,
    marker = `STUDY_INTERPRETER_${id}`;
  const startedAt = new Date().toISOString(),
    start = performance.now();
  let imageId;
  try {
    if (react) return await executeReact(react, id);
    const image = await docker([
      "image",
      "inspect",
      images[input.language],
      "--format",
      "{{.Id}}",
    ]);
    imageId = image.stdout.trim();
    if (image.exitCode !== 0 || !/^sha256:[a-f0-9]{64}$/.test(imageId))
      return {
        id,
        status: "unavailable",
        executed: false,
        language: input.language,
        detail:
          "Start Docker and install the configured runner image; code was not executed.",
      };
    const args = [
      "create",
      "--rm",
      "--pull=never",
      "--name",
      name,
      "--network=none",
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--user=65534:65534",
      "--cpus=0.5",
      "--memory=128m",
      "--memory-swap=128m",
      "--pids-limit=32",
      "--ulimit=cpu=3:3",
      "--ulimit=nofile=64:64",
      "--ulimit=core=0:0",
      "--ulimit=fsize=1048576:1048576",
      "--tmpfs=/work:rw,noexec,nosuid,nodev,size=8m,mode=1777",
      "--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=8m,mode=1777",
      "--workdir=/work",
      "--env=PYTHONDONTWRITEBYTECODE=1",
      "--env=PYTHONUNBUFFERED=1",
      "-i",
      imageId,
      "timeout",
      "-s",
      "KILL",
      "4",
    ];
    if (input.language === "python")
      args.push("python3", "-I", "-c", pythonBootstrap(marker));
    else
      args.push(
        "node",
        "--max-old-space-size=64",
        "-e",
        nodeBootstrap(marker, input.language),
      );
    const remove = () => {
      void docker(["rm", "--force", name]);
    };
    const created = await docker(args);
    if (created.exitCode !== 0)
      return {
        id,
        status: "unavailable",
        executed: false,
        language: input.language,
        detail:
          "The isolated container could not be created; code was not executed.",
      };
    const result = await docker(
      ["start", "--attach", "--interactive", name],
      codePacket(input.code),
      5000,
      remove,
    );
    const executed = result.stderrPrefix.split("\n").includes(marker);
    return {
      id,
      language: input.language,
      imageId,
      startedAt,
      codeHash: sha256(input.code),
      durationMs: Math.round(performance.now() - start),
      status: !executed
        ? "unavailable"
        : (result.reason ??
          ([124, 137, 152].includes(result.exitCode)
            ? "resource-limit"
            : "completed")),
      executed,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr.replace(marker + "\n", ""),
      limits: {
        network: "none",
        hostMounts: false,
        memoryMiB: 128,
        cpus: 0.5,
        processes: 32,
        wallTimeMs: 5000,
        outputBytes: maxOutput,
      },
    };
  } finally {
    // Also clean up after a client/CLI failure or a process that forked children.
    if (!react) await docker(["rm", "--force", name]);
    active = false;
  }
}
