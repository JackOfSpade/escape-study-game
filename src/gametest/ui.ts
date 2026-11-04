import "./lab.css";
import { nearbyDoor, nearestGrip } from "../engine";
import { doorFrame } from "../doors";
import { H, W, type Roadmap } from "../model";
import { boxBounds } from "../furniture-geometry";
import { PRESETS, preset } from "./presets";
import { TestRunner } from "./runner";
import {
  LAB_LIMITS,
  emptyScenario,
  parseScenario,
  type Action,
  type Scenario,
  type SpawnKind,
} from "./schema";
import { captureLayout, entity, layoutAngle } from "./world";
const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
$("lab").innerHTML =
  `<header><div><small>zombie-escape-study-game / DEVELOPMENT</small><h1>Test Lab</h1><span class="muted">Build a setup. Run it repeatedly. Inspect what failed.</span></div><a href="/" target="_blank" rel="noopener">Open game ↗</a></header>
<main class="layout"><aside class="left-panel"><section class="panel stack"><h2>Test setups</h2><label>Scenario<select id="lab-presets"></select></label><div class="row"><button id="lab-load">Load</button><button id="lab-new">Blank arena</button></div><label>Scenario name<input id="lab-name" maxlength="160"/></label><div class="fields"><label>Seed<input id="lab-seed" type="number" min="0" max="4294967295"/></label><label>Max ticks<input id="lab-max-ticks" type="number" min="1" max="${LAB_LIMITS.ticks}"/></label></div><label>Simulation<select id="lab-simulation"><option value="game">Game · NPC behavior + physics</option><option value="physics">Motor test · physics + avoidance</option></select></label><label class="check"><input type="checkbox" id="lab-spawns"/>Natural zombie spawns</label><button id="lab-settings">Apply settings</button><button id="lab-save">Save setup locally</button><p class="help">Newest 12 lab setups, up to 2 MB. Game saves and learning records are separate.</p></section>
<section class="panel stack"><h2>Build & inspect</h2><label>Tool<select id="lab-tool"><option value="select">Select / inspect</option><option value="wall">Paint wall</option><option value="floor">Paint floor</option><option value="player">Place player</option><option value="npc">Spawn NPC</option><option value="zombie">Spawn zombie</option><option value="chair">Place chair</option><option value="desk">Place desk</option><option value="sofa">Place sofa</option><option value="fridge">Place fridge</option><option value="shelf">Place shelf</option><option value="officeChair">Place office chair</option><option value="table">Place meeting table</option><option value="cabinet">Place filing cabinet</option><option value="cooler">Place water cooler</option><option value="plant">Place plant</option><option value="printer">Place printer</option><option value="whiteboard">Place whiteboard</option><option value="partition">Place cubicle partition</option><option value="door">Place hinged door</option><option value="erase">Remove object</option></select></label><label>Floor<select id="lab-floor">${Array.from({ length: 5 }, (_, i) => `<option value="${i}">Floor ${i + 1}</option>`).join("")}</select></label><label>Entity<select id="lab-entities"><option value="">Select an entity</option></select></label><div class="fields" id="entity-inspector" hidden><label class="wide">ID<input id="entity-id" readonly/></label><label>X<input id="entity-x" type="number" step=".1"/></label><label>Y<input id="entity-y" type="number" step=".1"/></label><label>Health<input id="entity-hp" type="number" min="0"/></label><label>Angle °<input id="entity-angle" type="number" step="5"/></label><label>Width<input id="entity-w" type="number" min=".1" step=".1"/></label><label>Height<input id="entity-h" type="number" min=".1" step=".1"/></label><label class="check wide"><input id="entity-released" type="checkbox"/>Door latch released</label><label class="check wide"><input id="entity-credential" type="checkbox"/>Stair credential on this floor</label><button id="entity-apply" class="wide">Apply entity changes</button><button id="entity-remove" class="wide">Remove entity</button></div><p class="help">Click the floor to place or select. Editing resets the run to its setup. Select an entity to change its position, dimensions, health or door swing.</p></section></aside>
<section><div class="panel"><div class="toolbar"><button id="lab-run" class="primary">Run test</button><button id="lab-play">Play / pause</button><button id="lab-step">Step 1 tick</button><button id="lab-step30">Step 30 ticks</button><button id="lab-reset">Reset</button><span id="lab-status" class="badge" role="status">Ready</span></div><div class="canvas-caption"><span id="lab-clock">Tick 0 · 0.00 s</span><span id="lab-coordinates" class="pill">Full floor view · test mode</span></div><canvas id="lab-world" tabindex="0" aria-label="Test arena. Click to place entities. WASD moves the player, E interacts, Space jumps or vaults, Escape pauses."></canvas><p class="legend">White: player · teal: NPC · green: zombie · orange: released door<br>Real walls, rigid bodies and hinges. Full-floor diagnostic view.</p><div class="row"><label class="check"><input id="lab-routes" type="checkbox" checked/>Show NPC routes</label><label class="check"><input id="lab-labels" type="checkbox" checked/>Show IDs</label></div><p id="lab-message" role="status">Loading Test Lab…</p><details><summary>Keyboard and recording</summary><p class="help">Focus the arena and press WASD, E or Space. Inputs are recorded at simulation ticks; Export recording can replay them from the same starting setup. Escape pauses. Motor tests run scripted body motors with AI disabled; use Game mode for normal NPC decisions and combat.</p></details></div><section class="panel"><h2>Assertions</h2><ul class="results" id="lab-results"></ul><p class="help">No assertions means an unverified sandbox, never a passing test. Edit the JSON below to add at-tick, always or eventual checks.</p></section></section>
<aside class="right-panel"><section class="panel stack"><h2>Reusable scenario JSON</h2><textarea id="lab-json" aria-label="Scenario JSON" spellcheck="false"></textarea><button id="lab-apply-json">Apply JSON setup</button><label>Import setup<input id="lab-import" type="file" accept="application/json,.json"/></label><div class="row"><button id="lab-export">Export setup</button><button id="lab-recording">Export recording</button><button id="lab-report">Export result</button></div><button id="lab-capture">Capture current layout as setup</button><p class="help">Layout capture preserves positions, walls and door poses, and clears actions/checks. It does not capture study data or NPC memory.</p></section><section class="panel stack"><h2>Regression suite</h2><button id="lab-all">Run all built-in tests</button><ul class="results" id="lab-suite"></ul><button id="lab-suite-report" disabled>Export suite report</button><p class="help">The same definitions also run with <code>npm run test:game</code>. Failures retain their scene for inspection.</p></section></aside></main><footer>Isolated lab · no study bridge or AI requests · no game-save writes · 30 simulation ticks per second</footer>`;
const roadmap: Roadmap = await fetch("/curriculum.json").then((r) => {
  if (!r.ok) throw Error("Could not load test curriculum");
  return r.json();
});
const LIBRARY_KEY = "zombie-game-test-lab-v1";
let library: Scenario[] = [],
  libraryError = "";
try {
  const raw = localStorage.getItem(LIBRARY_KEY);
  if (raw) {
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data) || data.length > 12)
      throw Error("Invalid lab library");
    library = data.map(parseScenario);
  }
} catch (error) {
  libraryError = `Saved lab setups could not be loaded: ${error}`;
}
let draft = preset("opening-crowd"),
  runner = new TestRunner(draft, roadmap),
  selected = "",
  playing = false,
  busy = false,
  last = 0,
  acc = 0;
let suite: ReturnType<TestRunner["report"]>[] = [];
const canvas = $<HTMLCanvasElement>("lab-world"),
  keys = new Set<string>();
function message(text: string, error = false) {
  $("lab-message").textContent = text;
  $("lab-message").classList.toggle("error", error);
}
function guarded(fn: () => void) {
  try {
    fn();
  } catch (error) {
    message(String(error), true);
  }
}
/** The select value for a scenario: library entries carry the `saved:` prefix. */
function optionValue(s: Scenario) {
  return PRESETS.some((p) => p.id === s.id) ? s.id : `saved:${s.id}`;
}
function options() {
  const select = $<HTMLSelectElement>("lab-presets");
  select.replaceChildren();
  for (const s of [...PRESETS, ...library]) {
    const o = document.createElement("option");
    o.value = optionValue(s);
    o.textContent = s.name + (library.includes(s) ? " · saved" : "");
    select.append(o);
  }
  select.value = optionValue(draft);
}
function form() {
  $<HTMLInputElement>("lab-name").value = draft.name;
  $<HTMLInputElement>("lab-seed").value = String(draft.seed);
  $<HTMLInputElement>("lab-max-ticks").value = String(draft.maxTicks);
  $<HTMLSelectElement>("lab-simulation").value = draft.simulation;
  $<HTMLInputElement>("lab-spawns").checked = draft.naturalSpawns;
  $<HTMLTextAreaElement>("lab-json").value = JSON.stringify(draft, null, 2);
}
function load(value: Scenario) {
  const next = parseScenario(value),
    world = new TestRunner(next, roadmap);
  playing = false;
  keys.clear();
  acc = 0;
  draft = next;
  runner = world;
  selected = "";
  form();
  listEntities();
  inspect();
  update();
  message(`Loaded ${draft.name}. Ready for a fresh run.`);
}
function edit(fn: (s: Scenario) => void) {
  const copy = structuredClone(draft);
  fn(copy);
  load(copy);
  message("Setup changed. The previous run was reset.");
}
function allEntities() {
  return [
    ...runner.game.survivors,
    ...runner.game.zombies,
    ...runner.game.floors.flatMap((f) => f.furniture),
  ];
}
function listEntities() {
  const select = $<HTMLSelectElement>("lab-entities"),
    floor = Number($<HTMLSelectElement>("lab-floor").value);
  select.replaceChildren(new Option("Select an entity", ""));
  for (const e of allEntities().filter((e) => e.floor === floor)) {
    select.append(
      new Option(`${e.id}${"kind" in e ? ` · ${e.kind}` : ""}`, e.id),
    );
  }
  select.value = selected;
}
function inspect() {
  const e = entity(runner.game, selected);
  $("entity-inspector").hidden = !e;
  if (!e) return;
  const frame = "door" in e && e.door ? doorFrame(e) : e;
  $<HTMLInputElement>("entity-id").value = e.id;
  for (const [key, value] of Object.entries({
    x: frame.x,
    y: frame.y,
    hp: e.hp,
    angle: "kind" in e ? layoutAngle(e) : 0,
    w: "w" in frame ? frame.w : 0,
    h: "h" in frame ? frame.h : 0,
  }))
    $<HTMLInputElement>(`entity-${key}`).value = String(
      Number(value).toFixed(3),
    );
  for (const key of ["w", "h", "angle"])
    $<HTMLInputElement>(`entity-${key}`).disabled = !("kind" in e);
  $<HTMLInputElement>("entity-released").checked =
    "door" in e && !!e.door && !e.door.latched;
  $<HTMLInputElement>("entity-released").disabled = !("door" in e && e.door);
  $<HTMLInputElement>("entity-credential").checked =
    "access" in e && e.access.includes(e.floor);
  $<HTMLInputElement>("entity-credential").disabled = !("access" in e);
  $<HTMLButtonElement>("entity-remove").disabled = e.id === "human";
}
function update() {
  const r = runner.report();
  $("lab-status").textContent = r.status;
  $("lab-status").dataset.status = r.status;
  $("lab-clock").textContent =
    `Tick ${r.tick} / ${runner.scenario.maxTicks} · ${r.time.toFixed(2)} s`;
  const ul = $("lab-results");
  ul.replaceChildren();
  for (const c of r.checks) {
    const li = document.createElement("li");
    li.dataset.status = c.status;
    li.textContent = `${c.status.toUpperCase()} · ${c.status === "pending" ? c.name : c.message}`;
    ul.append(li);
  }
  if (r.error) message(r.error, true);
  if (!["ready", "running"].includes(r.status)) playing = false;
  draw();
}
function draw() {
  const rect = canvas.getBoundingClientRect(),
    dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(((rect.width * H) / W) * dpr));
  const ctx = canvas.getContext("2d")!,
    scale = canvas.width / W;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.fillStyle = "#0b191c";
  ctx.fillRect(0, 0, W, H);
  const floor = Number($<HTMLSelectElement>("lab-floor").value),
    f = runner.game.floors[floor];
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      ctx.fillStyle = f.tiles[y][x] ? "#425551" : "#172c2e";
      ctx.fillRect(x + 0.02, y + 0.02, 0.96, 0.96);
    }
  if ($<HTMLInputElement>("lab-routes").checked) {
    ctx.strokeStyle = "#7cbdad88";
    ctx.lineWidth = 0.045;
    for (const a of runner.game.survivors.filter(
      (a) => a.floor === floor && a.path.length,
    )) {
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      for (const p of a.path) ctx.lineTo(p.x, p.y);
      ctx.stroke();
    }
  }
  for (const e of allEntities().filter((e) => e.floor === floor)) {
    ctx.save();
    ctx.translate(e.x, e.y);
    if ("kind" in e) {
      if (e.destroyed) {
        ctx.restore();
        continue;
      }
      ctx.rotate(e.angle ?? 0);
      ctx.fillStyle = e.door
        ? e.door.latched
          ? "#a8af88"
          : "#e2a85c"
        : "#9a836b";
      ctx.fillRect(-e.w / 2, -e.h / 2, e.w, e.h);
      ctx.strokeStyle = "#d8d6b5";
      ctx.lineWidth = 0.035;
      ctx.strokeRect(-e.w / 2, -e.h / 2, e.w, e.h);
    } else {
      ctx.fillStyle =
        "origin" in e ? "#96a644" : e.id === "human" ? "#f0f6e8" : "#55ceb7";
      ctx.globalAlpha = e.hp <= 0 ? 0.35 : 1;
      ctx.beginPath();
      ctx.arc(0, 0, 0.26, 0, Math.PI * 2);
      ctx.fill();
      if ("heading" in e) {
        ctx.strokeStyle = "#10271e";
        ctx.lineWidth = 0.05;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(e.heading.x * 0.35, e.heading.y * 0.35);
        ctx.stroke();
      }
    }
    ctx.restore();
    if (selected === e.id) {
      const b = "w" in e ? boxBounds(e) : { w: 0.7, h: 0.7 };
      ctx.strokeStyle = "#b4ffe5";
      ctx.lineWidth = 0.07;
      ctx.strokeRect(
        e.x - b.w / 2 - 0.08,
        e.y - b.h / 2 - 0.08,
        b.w + 0.16,
        b.h + 0.16,
      );
    }
    if ($<HTMLInputElement>("lab-labels").checked) {
      ctx.fillStyle = "#e7f1de";
      ctx.font = ".28px system-ui";
      ctx.fillText(e.id, e.x + 0.25, e.y - 0.3);
    }
    if ("door" in e && e.door) {
      ctx.fillStyle = "#f8db8e";
      ctx.beginPath();
      ctx.arc(e.door.hinge.x, e.door.hinge.y, 0.09, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  for (const [i, c] of runner.scenario.checks.entries())
    if (
      runner.results[i].status === "failed" &&
      c.query.type === "region" &&
      c.query.floor === floor
    ) {
      const q = c.query;
      ctx.strokeStyle = "#ff775d";
      ctx.lineWidth = 0.12;
      ctx.strokeRect(q.x1, q.y1, q.x2 - q.x1, q.y2 - q.y1);
    }
}
function download(name: string, value: unknown) {
  const url = URL.createObjectURL(
      new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
    ),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function queue(action: Omit<Action, "tick">) {
  if (busy || !["ready", "running"].includes(runner.status)) return;
  runner.scenario.actions.push({ ...action, tick: runner.tick + 1 } as Action);
}
function movement() {
  queue({
    type: "move",
    id: "human",
    x:
      Number(keys.has("KeyD") || keys.has("ArrowRight")) -
      Number(keys.has("KeyA") || keys.has("ArrowLeft")),
    y:
      Number(keys.has("KeyS") || keys.has("ArrowDown")) -
      Number(keys.has("KeyW") || keys.has("ArrowUp")),
  } as Omit<Action, "tick">);
}
canvas.addEventListener("keydown", (ev) => {
  if (
    ![
      "KeyW",
      "KeyA",
      "KeyS",
      "KeyD",
      "ArrowUp",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
      "KeyE",
      "Space",
      "Escape",
    ].includes(ev.code)
  )
    return;
  ev.preventDefault();
  if (ev.code === "Escape") {
    playing = false;
    return;
  }
  if (ev.repeat) return;
  if (ev.code === "KeyE") {
    const a = runner.game.survivors[0],
      door = nearbyDoor(runner.game, a),
      grip = nearestGrip(runner.game, a);
    if (a.grip)
      queue({ type: "grip", id: "human", target: a.grip.object } as Omit<
        Action,
        "tick"
      >);
    else if (door?.field || door?.door?.latched)
      queue({ type: "door", id: "human", target: door.id } as Omit<
        Action,
        "tick"
      >);
    else if (grip)
      queue({ type: "grip", id: "human", target: grip.id } as Omit<
        Action,
        "tick"
      >);
  } else if (ev.code === "Space") {
    if (runner.scenario.simulation === "game")
      queue({ type: "jump", id: "human" } as Omit<Action, "tick">);
  } else {
    keys.add(ev.code);
    movement();
  }
});
window.addEventListener("keyup", (ev) => {
  if (keys.delete(ev.code)) movement();
});
canvas.addEventListener("blur", () => {
  if (keys.size) {
    keys.clear();
    movement();
  }
});
canvas.addEventListener("pointermove", (ev) => {
  const r = canvas.getBoundingClientRect();
  $("lab-coordinates").textContent =
    `x ${(((ev.clientX - r.left) / r.width) * W).toFixed(1)} · y ${(((ev.clientY - r.top) / r.height) * H).toFixed(1)}`;
});
canvas.addEventListener("pointerdown", (ev) =>
  guarded(() => {
    canvas.focus();
    if (busy) return;
    const r = canvas.getBoundingClientRect(),
      x = ((ev.clientX - r.left) / r.width) * W,
      y = ((ev.clientY - r.top) / r.height) * H,
      floor = Number($<HTMLSelectElement>("lab-floor").value),
      tool = $<HTMLSelectElement>("lab-tool").value;
    const hit = allEntities()
      .filter((e) => e.floor === floor)
      .reverse()
      .find((e) => {
        const b = "w" in e ? boxBounds(e) : { w: 0.65, h: 0.65 };
        return (
          Math.abs(e.x - x) < b.w / 2 + 0.1 && Math.abs(e.y - y) < b.h / 2 + 0.1
        );
      });
    if (tool === "select") {
      selected = hit?.id ?? "";
      listEntities();
      inspect();
      draw();
      return;
    }
    if (tool === "erase") {
      if (hit && hit.id !== "human")
        edit((s) => {
          s.entities = s.entities.filter((e) => e.id !== hit.id);
          s.deleted.push(hit.id);
        });
      return;
    }
    if (tool === "wall" || tool === "floor") {
      edit((s) => {
        let map = s.maps.find((m) => m.floor === floor);
        if (!map) {
          map = {
            floor,
            rows: runner.game.floors[floor].tiles.map((row) =>
              row.map((c) => (c ? "#" : ".")).join(""),
            ),
          };
          s.maps.push(map);
        }
        const xx = Math.min(W - 1, Math.max(0, Math.floor(x))),
          yy = Math.min(H - 1, Math.max(0, Math.floor(y)));
        map.rows[yy] =
          map.rows[yy].slice(0, xx) +
          (tool === "wall" ? "#" : ".") +
          map.rows[yy].slice(xx + 1);
      });
      return;
    }
    const id =
      tool === "player"
        ? "human"
        : `${tool}-${crypto.randomUUID().slice(0, 8)}`;
    edit((s) => {
      s.entities = s.entities.filter((e) => e.id !== id);
      s.entities.push({
        id,
        kind: tool as SpawnKind,
        x: Math.floor(x) + 0.5,
        y: Math.floor(y) + 0.5,
        floor,
      });
    });
    selected = id;
    listEntities();
    inspect();
    draw();
  }),
);
$("entity-apply").onclick = () =>
  guarded(() => {
    const e = entity(runner.game, selected);
    if (!e) return;
    const id = e.id,
      kind: SpawnKind =
        "kind" in e
          ? e.kind
          : "origin" in e
            ? "zombie"
            : id === "human"
              ? "player"
              : "npc";
    edit((s) => {
      s.entities = s.entities.filter((v) => v.id !== id);
      s.entities.push({
        id,
        kind,
        x: Number($<HTMLInputElement>("entity-x").value),
        y: Number($<HTMLInputElement>("entity-y").value),
        floor: e.floor,
        hp: Number($<HTMLInputElement>("entity-hp").value),
        ...("kind" in e
          ? {
              maxHp:
                "maxHp" in e
                  ? Math.max(
                      e.maxHp,
                      Number($<HTMLInputElement>("entity-hp").value),
                    )
                  : undefined,
              w: Number($<HTMLInputElement>("entity-w").value),
              h: Number($<HTMLInputElement>("entity-h").value),
              angle: Number($<HTMLInputElement>("entity-angle").value),
              released: $<HTMLInputElement>("entity-released").checked,
            }
          : {}),
        credential: $<HTMLInputElement>("entity-credential").checked,
      });
    });
    selected = id;
    listEntities();
    inspect();
  });
$("entity-remove").onclick = () =>
  guarded(() => {
    if (!selected || selected === "human") return;
    const id = selected;
    edit((s) => {
      s.entities = s.entities.filter((e) => e.id !== id);
      s.deleted.push(id);
    });
  });
$("lab-entities").onchange = () => {
  selected = $<HTMLSelectElement>("lab-entities").value;
  inspect();
  draw();
};
$("lab-floor").onchange = () => {
  selected = "";
  listEntities();
  inspect();
  draw();
};
for (const id of ["lab-routes", "lab-labels"]) $(id).onchange = draw;
$("lab-load").onclick = () =>
  guarded(() => {
    const id = $<HTMLSelectElement>("lab-presets").value;
    load(
      id.startsWith("saved:")
        ? library.find((s) => s.id === id.slice(6))!
        : preset(id),
    );
  });
$("lab-new").onclick = () => load(emptyScenario());
$("lab-reset").onclick = () => load(draft);
$("lab-settings").onclick = () =>
  guarded(() =>
    edit((s) => {
      s.name = $<HTMLInputElement>("lab-name").value;
      s.seed = Number($<HTMLInputElement>("lab-seed").value);
      s.maxTicks = Number($<HTMLInputElement>("lab-max-ticks").value);
      s.simulation = $<HTMLSelectElement>("lab-simulation")
        .value as Scenario["simulation"];
      s.naturalSpawns = $<HTMLInputElement>("lab-spawns").checked;
    }),
  );
$("lab-step").onclick = () =>
  guarded(() => {
    playing = false;
    runner.advance();
    update();
  });
$("lab-step30").onclick = () =>
  guarded(() => {
    playing = false;
    runner.advance(Math.min(30, runner.scenario.maxTicks));
    update();
  });
$("lab-play").onclick = () => {
  if (!["ready", "running"].includes(runner.status)) load(draft);
  playing = !playing;
  acc = 0;
  canvas.focus();
};
async function execute(s: Scenario) {
  const test = new TestRunner(s, roadmap);
  runner = test;
  draft = structuredClone(s);
  selected = "";
  form();
  listEntities();
  inspect();
  $<HTMLSelectElement>("lab-presets").value = optionValue(s);
  playing = false;
  while (["ready", "running"].includes(test.status)) {
    test.advance(Math.min(15, s.maxTicks));
    update();
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
  }
  return test.report();
}
function lock(value: boolean) {
  busy = value;
  for (const control of document.querySelectorAll<
    | HTMLButtonElement
    | HTMLInputElement
    | HTMLSelectElement
    | HTMLTextAreaElement
  >("button,input,select,textarea"))
    control.disabled = value;
  if (!value) {
    $<HTMLButtonElement>("lab-suite-report").disabled = !suite.length;
    inspect();
  }
}
$("lab-run").onclick = async () => {
  lock(true);
  try {
    await execute(runner.scenario);
    listEntities();
    message(
      runner.status === "unverified"
        ? "Sandbox completed without assertions. Add checks to make this a regression test."
        : `Test ${runner.status}. ${runner.error ?? "Inspect assertions and the final scene."}`,
      runner.status === "failed",
    );
  } catch (error) {
    message(String(error), true);
  } finally {
    lock(false);
  }
};
$("lab-all").onclick = async () => {
  lock(true);
  suite = [];
  $("lab-suite").replaceChildren();
  let firstFailure: TestRunner | undefined;
  try {
    for (const s of PRESETS) {
      const r = await execute(s);
      suite.push(r);
      const li = document.createElement("li");
      li.dataset.status = r.status;
      li.textContent = `${r.status.toUpperCase()} · ${r.name}`;
      $("lab-suite").append(li);
      if (r.status === "failed" && !firstFailure) firstFailure = runner;
    }
    if (firstFailure) {
      runner = firstFailure;
      draft = structuredClone(runner.scenario);
      form();
      listEntities();
      update();
    }
    message(
      `${suite.filter((r) => r.status === "passed").length} / ${PRESETS.length} built-in tests passed.`,
      suite.some((r) => r.status === "failed"),
    );
  } catch (error) {
    message(String(error), true);
  } finally {
    lock(false);
  }
};
$("lab-apply-json").onclick = () =>
  guarded(() => load(parseScenario($<HTMLTextAreaElement>("lab-json").value)));
$("lab-import").onchange = async () => {
  try {
    const file = $<HTMLInputElement>("lab-import").files?.[0];
    if (file) {
      if (file.size > LAB_LIMITS.bytes) throw Error("Scenario exceeds 1 MB.");
      load(parseScenario(await file.text()));
    }
  } catch (error) {
    message(String(error), true);
  } finally {
    $<HTMLInputElement>("lab-import").value = "";
  }
};
$("lab-export").onclick = () => download(`${draft.id}.json`, draft);
$("lab-recording").onclick = () =>
  download(`${draft.id}-recording.json`, runner.scenario);
$("lab-report").onclick = () =>
  download(`${draft.id}-result.json`, {
    version: 1,
    scenario: runner.scenario,
    result: runner.report(),
  });
$("lab-suite-report").onclick = () =>
  download("gametest-suite.json", { version: 1, results: suite });
$("lab-capture").onclick = () =>
  guarded(() => load(captureLayout(runner.game, draft)));
$("lab-save").onclick = () =>
  guarded(() => {
    if (libraryError)
      throw Error(
        `${libraryError}. Export the current setup instead of overwriting the library.`,
      );
    const saved = parseScenario(draft);
    saved.id = `saved-${saved.id.replace(/^saved-/, "")}`.slice(0, 96);
    let next = [...library.filter((s) => s.id !== saved.id), saved].slice(-12);
    while (
      new TextEncoder().encode(JSON.stringify(next)).length > 2_000_000 &&
      next.length > 1
    )
      next = next.slice(1);
    if (new TextEncoder().encode(JSON.stringify(next)).length > 2_000_000)
      throw Error("Lab library is too large; export this setup instead.");
    localStorage.setItem(LIBRARY_KEY, JSON.stringify(next));
    library = next;
    options();
    message("Setup saved in the separate lab library.");
  });
function frame(time: number) {
  const elapsed = Math.min(0.2, (time - last) / 1000);
  last = time;
  if (playing && !busy) {
    acc += elapsed;
    let advanced = false;
    while (acc >= 1 / 30 && ["ready", "running"].includes(runner.status)) {
      runner.advance();
      acc -= 1 / 30;
      advanced = true;
    }
    // Redraw only when a tick ran, or once the run ended so `playing` clears.
    if (advanced || !["ready", "running"].includes(runner.status)) update();
  }
  requestAnimationFrame(frame);
}
window.addEventListener("resize", draw);
options();
load(draft);
requestAnimationFrame(frame);
if (libraryError) message(libraryError, true);
window.addEventListener("blur", () => {
  playing = false;
  if (keys.size) {
    keys.clear();
    movement();
  }
});
declare global {
  interface Window {
    __gameTestLab: {
      readonly runner: TestRunner;
      load: (s: Scenario) => void;
      run: () => Promise<void>;
    };
  }
}
window.__gameTestLab = {
  get runner() {
    return runner;
  },
  load,
  run: async () => {
    await execute(draft);
  },
};
