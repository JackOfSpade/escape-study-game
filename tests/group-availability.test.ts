// Controlled transport; real physical actions must defer technical replies.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  checkBridge,
  npcCanRespond,
  responders,
  retryGroupRequest,
  send,
} from "../src/ai";
import { eligible } from "../src/curriculum";
import { stairs, step, vault } from "../src/engine";
import type { Roadmap } from "../src/model";
import { decode, encode, recover } from "../src/persistence";
import { cancelStairs } from "../src/stair-travel";
import { createGame } from "../src/world";
const r: Roadmap = JSON.parse(readFileSync("public/curriculum.json", "utf8"));
for (const action of ["retreat", "vault", "stairs"] as const)
  test(`group reply waits through ${action} without a visible enemy, preserves exact retry and delivers once after recovery`, async () => {
    const g = createGame(71, r),
      e = g.encounters["f0-room0"],
      a = g.survivors[1],
      f = g.floors[0];
    g.study.profile = "live";
    g.status = "playing";
    g.zombies = [];
    g.nextSpawn = Number.MAX_SAFE_INTEGER;
    e.mode = "shared";
    e.problem = {
      title: "Controlled availability",
      prompt: "Synthetic task",
      starter: "",
      rubric: [],
      provenance: "chatgpt-handoff",
      contract: eligible(r, g.study),
    };
    const chair = structuredClone(f.furniture.find((o) => o.kind === "chair")!);
    f.tiles = Array.from({ length: 34 }, () => Array(44).fill(0));
    f.furniture = [];
    for (const other of g.survivors.slice(2)) other.escaped = true;
    Object.assign(a, {
      floor: 0,
      x: 10,
      y: 6,
      intent: e.id,
      thought: 12,
      heading: { x: 1, y: 0 },
      cooldown: 0,
    });
    assert.equal(npcCanRespond(g, e, a), true);
    const original = globalThis.fetch;
    let resolve!: (r: Response) => void,
      calls = 0,
      payload: any;
    globalThis.fetch = async (url, init) => {
      if (String(url) === "/api/status")
        return Response.json({
          mode: "claude-cli",
          label: "Controlled availability",
          detail: "Fixture only",
          capabilities: ["group"],
        });
      calls++;
      const p = JSON.parse(String(init?.body)).payload;
      if (!payload) payload = p;
      else assert.deepEqual(p, payload);
      if (calls === 1)
        return new Promise<Response>((done) => {
          resolve = done;
        });
      return Response.json({
        requestId: p.requestId,
        sourceRevision: p.sourceRevision,
        messages: [
          {
            author: a.id,
            kind: "question",
            text: "Which boundary is still unknown?",
            refs: [],
          },
        ],
      });
    };
    await checkBridge();
    try {
      const pending = send(g, e, "group", "Which boundary should we trace?", r);
      assert.deepEqual(
        payload.speakers.map((s: any) => s.id),
        [a.id],
      );
      if (action === "retreat")
        Object.assign(a, {
          activity: "fleeing",
          fleeFloor: 0,
          fleeUntil: g.time + 3,
          fleeTarget: { x: 18, y: 6 },
        });
      if (action === "vault") {
        Object.assign(chair, { id: "availability-chair", x: 11.5, y: 6 });
        f.furniture = [chair];
        a.x = chair.x - chair.w / 2 - 0.55;
        assert.equal(vault(g, a, chair.id), true);
      }
      if (action === "stairs") {
        f.stairs = { x: a.x, y: a.y };
        a.access = [0];
        assert.equal(stairs(g, a), true);
      }
      const unavailable = recover(decode(encode(g))),
        savedActor = unavailable.survivors[1];
      assert.equal(
        npcCanRespond(unavailable, unavailable.encounters[e.id], savedActor),
        false,
        "saved physical state is unavailable even without a currently visible enemy",
      );
      assert.deepEqual(responders(g, e, "Boundary?"), []);
      resolve(
        Response.json({
          requestId: payload.requestId,
          sourceRevision: payload.sourceRevision,
          messages: [
            {
              author: a.id,
              kind: "question",
              text: "Which boundary is still unknown?",
              refs: [],
            },
          ],
        }),
      );
      await pending;
      const job = e.groupRequests!.at(-1)!,
        captured = job.payloadJson;
      assert.equal(job.state, "interrupted");
      assert.equal(e.group.filter((m) => m.kind === "npc").length, 0);
      await retryGroupRequest(g, e, job.id);
      assert.equal(
        calls,
        1,
        "unavailable retry cannot send another model request",
      );
      if (action === "retreat") {
        a.activity = "waiting";
        delete a.fleeTarget;
        a.fleeUntil = 0;
      }
      if (action === "vault")
        for (let n = 0; n < 40 && a.vault; n++) step(g, 1 / 30);
      if (action === "stairs") cancelStairs(g, a);
      assert.equal(npcCanRespond(g, e, a), true);
      await retryGroupRequest(g, e, job.id);
      assert.equal(calls, 2);
      assert.equal(job.state, "applied");
      assert.equal(job.payloadJson, captured);
      await retryGroupRequest(g, e, job.id);
      assert.equal(calls, 2);
      assert.equal(e.group.filter((m) => m.requestId === job.id).length, 1);
    } finally {
      globalThis.fetch = async () =>
        Response.json({
          mode: "development",
          label: "Development",
          detail: "Fixture restored",
          capabilities: [],
        });
      await checkBridge();
      globalThis.fetch = original;
    }
  });
