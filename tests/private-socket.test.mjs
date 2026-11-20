import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  lstatSync,
  readFileSync,
  writeFileSync,
  symlinkSync,
} from "node:fs";
import { createServer } from "node:net";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { preparePrivateSocket } from "../scripts/private-socket.mjs";

test(
  "restart reclaims an owned abandoned socket after an abrupt synthetic child exit",
  { skip: process.platform === "win32" },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "study-socket-")),
      path = join(dir, "b.sock");
    try {
      const child = spawnSync(process.execPath, [
        "--input-type=module",
        "-e",
        'import {createServer} from "node:net"; const s=createServer();s.listen(process.argv[1],()=>process.kill(process.pid,"SIGKILL"));',
        path,
      ]);
      assert.equal(child.signal, "SIGKILL");
      assert.ok(lstatSync(path).isSocket());
      await preparePrivateSocket(path);
      assert.throws(() => lstatSync(path), { code: "ENOENT" });
      await preparePrivateSocket(path);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "restart preserves an active socket, ordinary files and symlinks",
  { skip: process.platform === "win32" },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "study-socket-")),
      path = join(dir, "b.sock");
    const server = createServer((socket) => socket.end());
    try {
      await new Promise((resolve) => server.listen(path, resolve));
      const inode = lstatSync(path).ino;
      await assert.rejects(preparePrivateSocket(path), /live connector/);
      assert.equal(lstatSync(path).ino, inode);
      await new Promise((resolve) => server.close(resolve));
      writeFileSync(path, "preserve");
      await assert.rejects(preparePrivateSocket(path), /not an owned socket/);
      assert.equal(readFileSync(path, "utf8"), "preserve");
      const link = join(dir, "link");
      symlinkSync(path, link);
      await assert.rejects(preparePrivateSocket(link), /not an owned socket/);
      assert.ok(lstatSync(link).isSymbolicLink());
    } finally {
      if (server.listening)
        await new Promise((resolve) => server.close(resolve));
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
