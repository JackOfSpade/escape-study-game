import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chatBlockedReason,
  chatKeyAction,
  installPlayerChat,
  setPlayerVoiceDirector,
  type ChatKeyState,
} from "../src/player-chat";
import type { Game } from "../src/model";

const state = (over: Partial<ChatKeyState> = {}): ChatKeyState => ({
  open: false,
  inInput: false,
  key: "Enter",
  composing: false,
  repeat: false,
  busy: false,
  speakable: true,
  ...over,
});

test("a closed box opens on a fresh Enter only while the game can speak", () => {
  assert.equal(chatKeyAction(state()), "open");
  assert.equal(chatKeyAction(state({ repeat: true })), "pass");
  assert.equal(chatKeyAction(state({ busy: true })), "pass");
  assert.equal(chatKeyAction(state({ speakable: false })), "pass");
  for (const key of ["a", "Escape", " ", "Shift"])
    assert.equal(chatKeyAction(state({ key })), "pass", key);
});

test("Enter in the box sends unless it is composing", () => {
  assert.equal(
    chatKeyAction(state({ open: true, inInput: true, key: "Enter" })),
    "send",
  );
  assert.equal(
    chatKeyAction(
      state({ open: true, inInput: true, key: "Enter", composing: true }),
    ),
    "swallow",
  );
});

test("Escape in the box closes it", () => {
  assert.equal(
    chatKeyAction(
      state({ open: true, inInput: true, key: "Escape", composing: true }),
    ),
    "close",
  );
});

test("every other key in the box is swallowed, never sent", () => {
  for (const key of ["a", "Backspace", " ", "ArrowLeft", "Shift"]) {
    const action = chatKeyAction(state({ open: true, inInput: true, key }));
    assert.equal(action, "swallow", key);
  }
});

test("a key while focus is outside the box closes it and passes", () => {
  for (const key of ["w", "Enter", "Escape", " "]) {
    const action = chatKeyAction(state({ open: true, inInput: false, key }));
    assert.equal(action, "close", key);
  }
});

test("every reason a game cannot speak for the player is named", () => {
  const game = (over: Record<string, unknown>) =>
    ({
      escape: {},
      status: "playing",
      paused: false,
      settings: {},
      ...over,
    }) as unknown as Game;
  assert.equal(chatBlockedReason(undefined), "no-game");
  assert.equal(chatBlockedReason(game({ escape: undefined })), "no-escape");
  assert.equal(chatBlockedReason(game({ status: "dead" })), "not-playing");
  assert.equal(chatBlockedReason(game({ paused: true })), "paused");
  assert.equal(
    chatBlockedReason(game({ settings: { npcVoices: false } })),
    "voices-off",
  );
  assert.equal(chatBlockedReason(game({})), undefined);
});

type Listener = (event: unknown) => void;
interface LogEntry {
  type: string;
  data?: Record<string, unknown>;
}
type Calls = { stopped: number; prevented: number };

function keyEvent(
  key: string,
  target: unknown,
  over: { repeat?: boolean; isComposing?: boolean } = {},
) {
  const calls: Calls = { stopped: 0, prevented: 0 };
  const event = {
    key,
    target,
    repeat: over.repeat ?? false,
    isComposing: over.isComposing ?? false,
    stopPropagation: () => {
      calls.stopped += 1;
    },
    preventDefault: () => {
      calls.prevented += 1;
    },
  };
  return { event, calls };
}

/* Minimal DOM: an element only needs what the chat box touches. */
interface FakeElement {
  tag: string;
  style: { cssText: string };
  attributes: Record<string, string>;
  children: FakeElement[];
  listeners: Record<string, Listener[]>;
  value: string;
  maxLength: number;
  placeholder: string;
  spellcheck: boolean;
  isConnected: boolean;
  parent: FakeElement | undefined;
  setAttribute(name: string, value: string): void;
  append(child: FakeElement): void;
  remove(): void;
  focus(): void;
  addEventListener(type: string, fn: Listener): void;
  removeEventListener(type: string, fn: Listener): void;
  dispatch(type: string, event: unknown): void;
}

function harness(t: { after(fn: () => void): void }) {
  const savedWindow = (globalThis as { window?: unknown }).window;
  const savedDocument = (globalThis as { document?: unknown }).document;
  const doc = {
    activeElement: undefined as unknown,
    body: undefined as unknown as FakeElement,
    createElement(tag: string): FakeElement {
      const el: FakeElement = {
        tag,
        style: { cssText: "" },
        attributes: {},
        children: [],
        listeners: {},
        value: "",
        maxLength: 0,
        placeholder: "",
        spellcheck: true,
        isConnected: false,
        parent: undefined,
        setAttribute(name, value) {
          el.attributes[name] = value;
        },
        append(child) {
          child.parent = el;
          child.isConnected = true;
          el.children.push(child);
        },
        remove() {
          el.isConnected = false;
          if (el.parent)
            el.parent.children = el.parent.children.filter((c) => c !== el);
          if (doc.activeElement === el) doc.activeElement = doc.body;
        },
        focus() {
          doc.activeElement = el;
        },
        addEventListener(type, fn) {
          (el.listeners[type] ??= []).push(fn);
        },
        removeEventListener(type, fn) {
          el.listeners[type] = (el.listeners[type] ?? []).filter(
            (f) => f !== fn,
          );
        },
        dispatch(type, event) {
          for (const fn of [...(el.listeners[type] ?? [])]) fn(event);
        },
      };
      return el;
    },
  };
  doc.body = doc.createElement("body");
  doc.activeElement = doc.body;
  const listeners: { type: string; fn: Listener; capture?: boolean }[] = [];
  const win = {
    addEventListener(type: string, fn: Listener, capture?: boolean) {
      listeners.push({ type, fn, capture });
    },
    removeEventListener(type: string, fn: Listener, capture?: boolean) {
      const at = listeners.findIndex(
        (l) => l.type === type && l.fn === fn && !!l.capture === !!capture,
      );
      if (at >= 0) listeners.splice(at, 1);
    },
  };
  (globalThis as { window?: unknown }).window = win;
  (globalThis as { document?: unknown }).document = doc;
  t.after(() => {
    if (savedWindow === undefined)
      delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = savedWindow;
    if (savedDocument === undefined)
      delete (globalThis as { document?: unknown }).document;
    else (globalThis as { document?: unknown }).document = savedDocument;
    setPlayerVoiceDirector(undefined);
  });
  const box = () => doc.body.children.find((c) => c.tag === "div");
  const field = () => box()?.children.find((c) => c.tag === "input");
  const press = (
    key: string,
    target: unknown = doc.activeElement,
    over: { repeat?: boolean; isComposing?: boolean } = {},
  ) => {
    const { event, calls } = keyEvent(key, target, over);
    const keydowns = listeners.filter((l) => l.type === "keydown");
    for (const listener of keydowns) listener.fn(event);
    return calls;
  };
  return { doc, win, box, field, press };
}

const fakeGame = (over: Record<string, unknown> = {}) =>
  ({
    id: "run-1",
    status: "playing",
    paused: false,
    escape: {},
    settings: { npcVoices: true },
    floors: [],
    ...over,
  }) as unknown as Game;

function setup(
  t: { after(fn: () => void): void },
  game: Game | undefined,
  entries: LogEntry[],
) {
  const dom = harness(t);
  const uninstall = installPlayerChat({
    game: () => game,
    yaw: () => 0,
    keyboardBusy: () => false,
    log: (type, data) => entries.push({ type, data: data as LogEntry["data"] }),
  });
  t.after(() => uninstall());
  return dom;
}

function heard() {
  const lines: string[] = [];
  setPlayerVoiceDirector({
    speakAsPlayer: (_game, text) => {
      lines.push(text);
      return true;
    },
  });
  return lines;
}

test("Enter opens the box and Enter sends the typed line, then closes it", (t) => {
  const spoken = heard();
  const entries: LogEntry[] = [];
  const dom = setup(t, fakeGame(), entries);
  dom.press("Enter", dom.doc.activeElement);
  assert.equal(dom.box()?.tag, "div", "box opened");
  assert.equal(dom.doc.activeElement, dom.field(), "input focused");
  assert.deepEqual(
    entries.map((e) => e.type),
    ["chat-open"],
  );
  assert.equal(entries[0].data, undefined);
  const line = "is anyone there?";
  dom.field()!.value = `  ${line}  `;
  const calls = dom.press("Enter", dom.field());
  assert.equal(dom.box(), undefined, "box removed after send");
  assert.deepEqual(spoken, [line], "director heard the trimmed line");
  assert.equal(calls.stopped, 1);
  assert.equal(calls.prevented, 1);
  const send = entries.find((e) => e.type === "chat-send");
  assert.ok(send, "chat-send logged");
  assert.deepEqual(Object.keys(send.data!).sort(), ["chars", "spoke"]);
  assert.equal(send.data!.chars, line.length);
  assert.equal(send.data!.spoke, true);
  assert.ok(!JSON.stringify(entries).includes("anyone"), "no message text");
  assert.equal(dom.win, (globalThis as { window?: unknown }).window);
});

test("Escape closes the box with reason escape and never sends", (t) => {
  const spoken = heard();
  const entries: LogEntry[] = [];
  const dom = setup(t, fakeGame(), entries);
  dom.press("Enter", dom.doc.activeElement);
  dom.field()!.value = "hello";
  const calls = dom.press("Escape", dom.field());
  assert.equal(dom.box(), undefined);
  assert.deepEqual(spoken, []);
  assert.equal(calls.stopped, 1);
  assert.equal(calls.prevented, 1);
  assert.deepEqual(
    entries.map((e) => [e.type, e.data]),
    [
      ["chat-open", undefined],
      ["chat-close", { reason: "escape" }],
    ],
  );
});

test("a key arriving while focus is elsewhere closes the box and passes untouched", (t) => {
  const entries: LogEntry[] = [];
  const dom = setup(t, fakeGame(), entries);
  dom.press("Enter", dom.doc.activeElement);
  dom.doc.activeElement = dom.doc.body;
  const calls = dom.press("w", dom.doc.body);
  assert.equal(dom.box(), undefined, "box closed");
  assert.equal(calls.stopped, 0, "not stopped");
  assert.equal(calls.prevented, 0, "not prevented");
  assert.deepEqual(entries.at(-1)!.data, { reason: "focus-lost" });
});

test("blurring the input closes the box with reason focus-lost", (t) => {
  const entries: LogEntry[] = [];
  const dom = setup(t, fakeGame(), entries);
  dom.press("Enter", dom.doc.activeElement);
  dom.field()!.dispatch("blur", {});
  assert.equal(dom.box(), undefined);
  assert.deepEqual(entries.at(-1)!.data, { reason: "focus-lost" });
  assert.equal(entries.length, 2, "close logged once");
});

test("a paused game closes the box and logs why nothing was spoken", (t) => {
  const spoken = heard();
  const entries: LogEntry[] = [];
  const game = fakeGame();
  const dom = setup(t, game, entries);
  dom.press("Enter", dom.doc.activeElement);
  game.paused = true;
  dom.field()!.value = "hello";
  dom.press("Enter", dom.field());
  assert.equal(dom.box(), undefined, "box closed even when silent");
  assert.deepEqual(spoken, []);
  assert.deepEqual(entries.at(-1)!.data, {
    chars: 5,
    dropped: "not-speakable",
    why: "paused",
  });
});

test("a director that answers with a promise logs the send as pending", (t) => {
  t.after(() => setPlayerVoiceDirector(undefined));
  let resolve: (spoke: boolean) => void = () => {};
  setPlayerVoiceDirector({
    speakAsPlayer: () =>
      new Promise<boolean>((done) => {
        resolve = done;
      }),
  });
  const entries: LogEntry[] = [];
  const dom = setup(t, fakeGame(), entries);
  dom.press("Enter", dom.doc.activeElement);
  dom.field()!.value = "later";
  dom.press("Enter", dom.field());
  assert.equal(entries.at(-1)!.data!.spoke, "pending");
  assert.equal(entries.at(-1)!.data!.chars, 5);
  resolve(true);
});
