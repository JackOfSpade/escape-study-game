// Per-kind, self-healing rate-limiter degradation through the real HTTP handler.
import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Direct local .mjs security integration.
import { createRequestHandler } from "../scripts/chatgpt-security/http.mjs";
// @ts-expect-error Direct local .mjs security integration.
import { CONSTANTS } from "../scripts/chatgpt-security/constants.mjs";

const hostname = "synthetic-game.lullascape.com";
const WELL_KNOWN_PATH = "/.well-known/oauth-protected-resource";
const AUTHORIZE_PATH = "/oauth/authorize";

function makeHarness() {
  let clock = 1_000_000;
  const audits: any[] = [];
  const ok = (_req: any, res: any) => {
    res.writeHead(200, {});
    res.end("{}");
  };
  const handler = createRequestHandler({
    hostname,
    now: () => clock,
    audit: { write: (entry: any) => audits.push(entry) },
    oauth: {
      protectedResource: ok,
      authorizationServer: ok,
      authorize: ok,
      token: ok,
      revoke: ok,
    },
    mcp: async () => ({}),
  });
  const hit = async (path: string, ip: string): Promise<number> => {
    let status = 0;
    const req: any = {
      method: "GET",
      url: path,
      headers: { host: hostname, "cf-connecting-ip": ip },
      socket: {},
      on() {},
    };
    const res: any = {
      headersSent: false,
      setHeader() {},
      on() {},
      once() {},
      off() {},
      writeHead(code: number) {
        status = code;
        this.headersSent = true;
      },
      end() {},
    };
    await handler(req, res);
    return status;
  };
  return {
    audits,
    hit,
    advance: (ms: number) => {
      clock += ms;
    },
    events: (ev: string) => audits.filter((entry) => entry.ev === ev),
  };
}

test("LRU eviction pressure degrades one kind, then heals", async () => {
  const h = makeHarness();
  const keys = CONSTANTS.BUCKET_LRU_KEYS as number;
  const limit = CONSTANTS.BUCKET_EVICTIONS_PER_MINUTE as number;
  assert.equal(keys, 512);
  assert.equal(limit, 50);

  // 1. Distinct sources overflow the well_known LRU. 20ms per request keeps
  // the 100/s aggregate refilled so it never blocks the setup traffic.
  const distinct = keys + limit + 2;
  for (let i = 0; i < distinct; i += 1) {
    const ip = `10.${(i >> 8) & 255}.${i & 255}.1`;
    assert.equal(await h.hit(WELL_KNOWN_PATH, ip), 200, `setup request ${i}`);
    h.advance(20);
  }
  assert.deepEqual(
    h.events("rate_lru_aggregate_only").map((e) => e.kind),
    ["well_known"],
  );
  assert.equal(h.events("rate_lru_per_source_restored").length, 0);

  // 2. A different kind is unaffected: one hammering source is still limited
  // per source (capacity 30) while the aggregate has plenty of room.
  h.advance(10_000);
  const authorizeCapacity = CONSTANTS.AUTHORIZE_BUCKET_CAPACITY as number;
  assert.equal(authorizeCapacity, 30);
  const authorizeStatuses: number[] = [];
  for (let i = 0; i < authorizeCapacity + 1; i += 1)
    authorizeStatuses.push(await h.hit(AUTHORIZE_PATH, "192.0.2.1"));
  assert.deepEqual(authorizeStatuses, [
    ...Array(authorizeCapacity).fill(200),
    429,
  ]);
  // While degraded, well_known has no per-source limiter: one source gets
  // past its 60-token capacity (only the shared aggregate applies).
  const wellKnownCapacity = CONSTANTS.WELLKNOWN_BUCKET_CAPACITY as number;
  for (let i = 0; i < wellKnownCapacity + 20; i += 1)
    assert.equal(await h.hit(WELL_KNOWN_PATH, "192.0.2.2"), 200);
  assert.equal(h.events("rate_lru_aggregate_only").length, 1);
  assert.equal(h.events("rate_lru_per_source_restored").length, 0);

  // 3. After the eviction window drains, per-source limiting is restored.
  h.advance(61_000);
  const healed: number[] = [];
  for (let i = 0; i < wellKnownCapacity + 1; i += 1)
    healed.push(await h.hit(WELL_KNOWN_PATH, "192.0.2.3"));
  assert.deepEqual(healed, [...Array(wellKnownCapacity).fill(200), 429]);
  assert.deepEqual(
    h.events("rate_lru_per_source_restored").map((e) => e.kind),
    ["well_known"],
  );
  assert.equal(h.events("rate_lru_aggregate_only").length, 1);
  assert.equal(
    h.audits.some((e) => e.kind === "authorize"),
    false,
  );
});
