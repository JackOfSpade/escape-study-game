/**
 * In-world player speech (docs/ESCAPE_REDESIGN.md sections 7 and 9).
 *
 * Enter opens a small chat box while the game keeps running, Enter speaks the
 * line in the player's voice and Escape closes the box. Nothing here pauses
 * the simulation.
 */
import type { Game } from "./model";
import { speakAsPlayer } from "./npc-voice";

export interface PlayerChatHost {
  /** The current game, or undefined while none is running. */
  game(): Game | undefined;
  /** Player yaw in radians (0 = +x), from the first-person controls. */
  yaw(): number;
  /** True while another text field (a terminal) owns the keyboard. */
  keyboardBusy(): boolean;
}

/** A director that can speak for the human; main.ts may inject its instance. */
export interface PlayerVoiceDirector {
  speakAsPlayer(
    game: Game,
    text: string,
    yaw: number,
  ): boolean | Promise<boolean>;
}

let injectedDirector: PlayerVoiceDirector | undefined;

/** Let the running voice director take player lines (optional wiring). */
export function setPlayerVoiceDirector(
  director: PlayerVoiceDirector | undefined,
) {
  injectedDirector = director;
}

export const PLAYER_CHAT_LIMITS = Object.freeze({ characters: 200 });

function gameSpeakable(game: Game | undefined): game is Game {
  return (
    !!game &&
    !!game.escape &&
    game.status === "playing" &&
    !game.paused &&
    game.settings.npcVoices !== false
  );
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

  const close = () => {
    if (!box) return;
    box.remove();
    box = undefined;
    input = undefined;
  };

  const send = () => {
    const game = host.game();
    const text = (input?.value ?? "")
      .trim()
      .slice(0, PLAYER_CHAT_LIMITS.characters);
    close();
    if (!text || !gameSpeakable(game)) return;
    const spoke = injectedDirector
      ? injectedDirector.speakAsPlayer(game, text, host.yaw())
      : speakAsPlayer(game, text, host.yaw());
    void spoke;
  };

  const open = () => {
    if (box) return;
    box = document.createElement("div");
    styleBox(box);
    input = document.createElement("input");
    styleInput(input);
    input.maxLength = PLAYER_CHAT_LIMITS.characters;
    input.placeholder = "Say something…";
    box.append(input);
    document.body.append(box);
    input.focus();
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        send();
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    });
    input.addEventListener("blur", () => {
      // Keep the box open unless something else took focus deliberately.
      if (box && input && !input.isConnected) close();
    });
  };

  const onKey = (event: KeyboardEvent) => {
    if (box) {
      // The chat box owns the keyboard while it is open; the game never sees
      // Escape, Enter or movement keys, and the world keeps stepping.
      event.stopPropagation();
      return;
    }
    if (event.key !== "Enter" || event.repeat) return;
    if (host.keyboardBusy() || !gameSpeakable(host.game())) return;
    event.preventDefault();
    event.stopPropagation();
    open();
  };

  window.addEventListener("keydown", onKey, true);
  return () => {
    window.removeEventListener("keydown", onKey, true);
    close();
  };
}
