/**
 * In-world player speech (docs/ESCAPE_REDESIGN.md sections 7 and 9).
 *
 * Enter opens a small chat box while the game keeps running, Enter speaks the
 * line in the player's voice and Escape closes the box. Nothing here pauses
 * the simulation.
 *
 * The window listener runs in the capture phase, so it sees every keydown
 * before the input does. `chatKeyAction` decides what that key means; this
 * module then performs it. Only keys that belong to the input are stopped, and
 * none of them are prevented, so typing keeps working and the game keeps its
 * hands off the keyboard while the box is open.
 */
import type { Game } from "./model";
import { speakAsPlayer } from "./npc-voice";

/** Speaks a player line; the live voice director (src/npc-voice.ts) fits this. */
export interface PlayerVoiceSpeaker {
  speakAsPlayer(
    game: Game,
    text: string,
    yaw: number,
  ): boolean | Promise<boolean>;
}

let voiceDirector: PlayerVoiceSpeaker | undefined;

/**
 * Point player speech at a director. Production leaves this unset: lines then
 * travel through src/npc-voice.ts's speakAsPlayer to the running director.
 */
export function setPlayerVoiceDirector(
  director: PlayerVoiceSpeaker | undefined,
) {
  voiceDirector = director;
}

export interface PlayerChatHost {
  /** The current game, or undefined while none is running. */
  game(): Game | undefined;
  /** Player yaw in radians (0 = +x), from the first-person controls. */
  yaw(): number;
  /** True while another text field (a terminal) owns the keyboard. */
  keyboardBusy(): boolean;
  /**
   * Diagnostics sink. Entries never carry the spoken text: only counts and
   * outcomes, so the run log holds no player content.
   */
  log?(type: string, data?: unknown): void;
}

export const PLAYER_CHAT_LIMITS = Object.freeze({ characters: 200 });

export type ChatKeyAction = "open" | "send" | "close" | "swallow" | "pass";

export interface ChatKeyState {
  /** True while the chat box is on screen. */
  open: boolean;
  /** True when the keydown's focus is the chat input. */
  inInput: boolean;
  key: string;
  composing: boolean;
  repeat: boolean;
  /** Another text field (a terminal) owns the keyboard. */
  busy: boolean;
  /** The current game can speak for the player right now. */
  speakable: boolean;
}

/**
 * What a keydown means for the chat box. Pure, so every branch is testable.
 *
 * - box closed: Enter (not a repeat, not busy, speakable) opens it; else pass.
 * - box open, focus in the input: Enter sends, Escape closes, anything else
 *   is swallowed (stopped, never prevented, so typing still reaches the
 *   browser's default action and the game stays put).
 * - box open, focus elsewhere: close and let the key through, so the movement
 *   key that closed the box also reaches the game.
 */
export function chatKeyAction(s: ChatKeyState): ChatKeyAction {
  if (!s.open) {
    if (s.key !== "Enter" || s.repeat) return "pass";
    return !s.busy && s.speakable ? "open" : "pass";
  }
  if (!s.inInput) return "close";
  if (s.key === "Enter") return s.composing ? "swallow" : "send";
  if (s.key === "Escape") return "close";
  return "swallow";
}

/** Why the current game cannot speak for the player, if it cannot. */
export type ChatBlockedReason =
  "no-game" | "no-escape" | "not-playing" | "paused" | "voices-off";

/** The first reason this game cannot speak for the player, or undefined. */
export function chatBlockedReason(
  game: Game | undefined,
): ChatBlockedReason | undefined {
  if (!game) return "no-game";
  if (!game.escape) return "no-escape";
  if (game.status !== "playing") return "not-playing";
  if (game.paused) return "paused";
  if (game.settings.npcVoices === false) return "voices-off";
  return undefined;
}

function gameSpeakable(game: Game | undefined): game is Game {
  return !chatBlockedReason(game);
}

function thenable(value: unknown): value is Promise<unknown> {
  return !!value && typeof (value as { then?: unknown }).then === "function";
}

function styleBox(box: HTMLDivElement) {
  box.style.cssText = [
    "position:fixed",
    "left:50%",
    "bottom:16%",
    "transform:translateX(-50%)",
    "z-index:40",
    "display:flex",
    "gap:6px",
    "padding:6px 8px",
    "border-radius:8px",
    "background:rgba(12,16,20,0.82)",
    "box-shadow:0 2px 12px rgba(0,0,0,0.45)",
    "font:14px system-ui,sans-serif",
    "color:#e8eef4",
  ].join(";");
}

function styleInput(input: HTMLInputElement) {
  input.style.cssText = [
    "width:34ch",
    "border:0",
    "outline:0",
    "background:transparent",
    "color:inherit",
    "font:inherit",
  ].join(";");
  input.setAttribute("aria-label", "Say something");
  input.setAttribute("autocomplete", "off");
  input.spellcheck = false;
}

/** Enter opens the chat box, Enter speaks the line aloud. Returns an uninstaller. */
export function installPlayerChat(host: PlayerChatHost): () => void {
  if (typeof document === "undefined" || typeof window === "undefined")
    return () => {};
  let box: HTMLDivElement | undefined;
  let input: HTMLInputElement | undefined;

  const drop = () => {
    const gone = box;
    box = undefined;
    input = undefined;
    gone?.remove();
  };

  /** Close the box, logging why unless the box was already gone. */
  const close = (reason: "escape" | "focus-lost") => {
    if (!box) return;
    drop();
    host.log?.("chat-close", { reason });
  };

  const send = () => {
    if (!input) return;
    const text = input.value.trim().slice(0, PLAYER_CHAT_LIMITS.characters);
    const chars = text.length;
    const game = host.game();
    // The box always closes, even when nothing can be said.
    drop();
    if (!text) {
      host.log?.("chat-send", { chars, dropped: "empty" });
      return;
    }
    const why = chatBlockedReason(game);
    if (!game || why) {
      host.log?.("chat-send", {
        chars,
        dropped: "not-speakable",
        why: why ?? "no-game",
      });
      return;
    }
    let spoke: boolean | Promise<boolean>;
    try {
      spoke = voiceDirector
        ? voiceDirector.speakAsPlayer(game, text, host.yaw())
        : speakAsPlayer(game, text, host.yaw());
    } catch {
      spoke = false;
    }
    host.log?.("chat-send", {
      chars,
      spoke: thenable(spoke) ? "pending" : Boolean(spoke),
    });
    if (thenable(spoke)) void spoke.catch(() => {});
  };

  const open = () => {
    if (box) return;
    const next = document.createElement("div");
    const field = document.createElement("input");
    box = next;
    input = field;
    styleBox(next);
    styleInput(field);
    field.maxLength = PLAYER_CHAT_LIMITS.characters;
    field.placeholder = "Say something…";
    next.append(field);
    document.body.append(next);
    // Focus loss (a click back into the world, another panel) closes the box.
    field.addEventListener("blur", () => {
      if (input === field) close("focus-lost");
    });
    field.focus();
    host.log?.("chat-open");
  };

  const onKey = (event: KeyboardEvent) => {
    const inInput =
      !!input && (event.target === input || document.activeElement === input);
    const action = chatKeyAction({
      open: !!box,
      inInput,
      key: event.key,
      composing: event.isComposing === true,
      repeat: event.repeat === true,
      busy: host.keyboardBusy(),
      speakable: gameSpeakable(host.game()),
    });
    if (action === "pass") return;
    if (action === "close") {
      // Focus is in the input: this is Escape. Focus is elsewhere: the key
      // belongs to the game, so it is neither stopped nor prevented.
      close(inInput ? "escape" : "focus-lost");
      if (!inInput) return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (action === "send") send();
    else if (action === "open") open();
  };

  // Keep the window we registered on: the uninstaller may run after the
  // page's globals are torn down (tests, hot reload).
  const win = window;
  win.addEventListener("keydown", onKey, true);
  return () => {
    win.removeEventListener("keydown", onKey, true);
    drop();
  };
}
