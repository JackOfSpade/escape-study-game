import { sha256 } from "./lib/digest.mjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
export const browserLimits = Object.freeze({
  memoryMiB: 512,
  cpus: 0.5,
  processes: 256,
  wallTimeMs: 17000,
  outputBytes: 262144,
});
export function browserContainerOptions(name) {
  if (!/^study-browser-[a-z0-9-]{1,80}$/.test(name))
    throw Error("Invalid owned browser container name");
  const profile = fileURLToPath(
      new URL("./browser-runner/seccomp-browser.json", import.meta.url),
    ),
    provenance = JSON.parse(
      readFileSync(
        new URL("./browser-runner/PROVENANCE.json", import.meta.url),
        "utf8",
      ),
    );
  if (sha256(readFileSync(profile)) !== provenance.derivedProfile.sha256)
    throw Error("Pinned Chromium sandbox profile changed");
  return [
    "--rm",
    "--init",
    "--name",
    name,
    "--pull=never",
    "--network=none",
    "--ipc=private",
    "--read-only",
    "--user=65534:65534",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    `--security-opt=seccomp=${profile}`,
    "--cpus=0.5",
    "--memory=512m",
    "--memory-swap=512m",
    "--pids-limit=256",
    "--ulimit=cpu=15:15",
    "--ulimit=nofile=1024:1024",
    "--ulimit=core=0:0",
    "--ulimit=fsize=8388608:8388608",
    "--shm-size=128m",
    "--tmpfs=/work:rw,noexec,nosuid,nodev,size=32m,mode=1777",
    "--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=128m,mode=1777",
  ];
}
