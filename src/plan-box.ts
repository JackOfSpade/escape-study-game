/**
 * The plan box (docs/ESCAPE_REDESIGN.md section 17).
 *
 * P opens a small box while the game keeps running; the player types how they
 * mean to get out, Enter thinks it through and Escape closes the box. It is
 * the character thinking, not speaking: nobody in the world hears it.
 */
import { PLAN_LIMITS } from "./escape-plan";
import type { Game } from "./model";

interface PlanBoxHost {
  /** The current game, or undefined while none is running. */
  game(): Game | undefined;
  /** True while another text field owns the keyboard. */
  keyboardBusy(): boolean;
  /** The player finished typing a plan. */
  submit(text: string): void;
  /** Diagnostics sink; entries never carry the typed text. */
  log?(type: string, data?: unknown): void;
}

type PlanKeyAction = "open" | "send" | "close" | "pass";

/** A game in which a plan can be made right now. */
export function planable(game: Game | undefined): boolean {
  return (
    !!game &&
    !!game.escape &&
    game.status === "playing" &&
    !game.studyWorkspace?.enabled &&
    !game.paused &&
    !game.escape.planPending
  );
}

/** What a keydown means for the plan box. Pure, so it is tested directly. */
export function planKeyAction(state: {
  open: boolean;
  inInput: boolean;
  key: string;
  composing: boolean;
  repeat: boolean;
  modified: boolean;
  busy: boolean;
  planable: boolean;
}): PlanKeyAction {
  if (state.composing) return "pass";
  if (state.open) {
    if (!state.inInput) return "close";
    if (state.key === "Escape") return "close";
    if (state.key === "Enter") return state.repeat ? "pass" : "send";
    return "pass";
  }
  if (
    (state.key === "p" || state.key === "P") &&
    !state.repeat &&
    !state.modified &&
    !state.busy &&
    state.planable
  )
    return "open";
  return "pass";
}

export function installPlanBox(host: PlanBoxHost): () => void {
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

  const open = () => {
    if (box) return;
    const next = document.createElement("div"),
      label = document.createElement("span"),
      field = document.createElement("input");
    box = next;
    input = field;
    next.id = "plan-box";
    next.style.cssText = [
      "position:fixed",
      "left:50%",
      "bottom:24%",
      "transform:translateX(-50%)",
      "z-index:40",
      "display:flex",
      "align-items:center",
      "gap:8px",
      "padding:8px 10px",
      "border-radius:8px",
      "background:rgba(12,16,20,0.88)",
      "box-shadow:0 2px 12px rgba(0,0,0,0.45)",
      "font:14px system-ui,sans-serif",
      "color:#e8eef4",
    ].join(";");
    label.textContent = "A way out:";
    label.style.opacity = "0.7";
    field.id = "plan-input";
    field.maxLength = PLAN_LIMITS.text;
    field.placeholder = "hotwire a car and drive away…";
    field.setAttribute("aria-label", "Your plan to get out");
    field.style.cssText = [
      "width:44ch",
      "border:0",
      "outline:0",
      "background:transparent",
      "color:inherit",
      "font:inherit",
    ].join(";");
    next.append(label, field);
    document.body.append(next);
    field.addEventListener("blur", () => {
      if (input === field) drop();
    });
    field.focus();
    host.log?.("plan-open");
  };

  const send = () => {
    if (!input) return;
    const text = input.value.trim().slice(0, PLAN_LIMITS.text);
    drop();
    if (!text || !planable(host.game())) {
      host.log?.("plan-send", { chars: text.length, dropped: true });
      return;
    }
    host.log?.("plan-send", { chars: text.length });
    host.submit(text);
  };

  const onKey = (event: KeyboardEvent) => {
    const inInput =
      !!input && (event.target === input || document.activeElement === input);
    const action = planKeyAction({
      open: !!box,
      inInput,
      key: event.key,
      composing: event.isComposing === true,
      repeat: event.repeat === true,
      modified: event.ctrlKey || event.metaKey || event.altKey,
      busy: host.keyboardBusy(),
      planable: planable(host.game()),
    });
    if (action === "pass") {
      // Typing in the box belongs to the box: the game must not see it.
      if (inInput) event.stopPropagation();
      return;
    }
    if (action === "close") {
      drop();
      if (!inInput) return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (action === "send") send();
    else if (action === "open") open();
  };

  const win = window;
  win.addEventListener("keydown", onKey, true);
  return () => {
    win.removeEventListener("keydown", onKey, true);
    drop();
  };
}
