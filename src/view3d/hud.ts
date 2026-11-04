import { doorFrame } from "../doors";
import {
  canBoard,
  human,
  nearbyDoor,
  nearestGrip,
  nearestStation,
} from "../engine";
import { surfacePoint } from "../furniture-geometry";
import { distance, type Game } from "../model";
import { objectName } from "../render";
import { accessDoorPrompt, lookTarget, lookTargetPrompt } from "./targeting";

/** Use the same reach queries and priority as E; the prompt never grants reach. */
export function interactionPrompt(game: Game, yaw?: number) {
  const a = human(game);
  if (a.grip) return "E · Release grip";
  if (canBoard(game, a)) return "E · Board helicopter";
  if (yaw !== undefined) {
    const target = lookTarget(game, yaw);
    if (target) return lookTargetPrompt(game, target);
  }
  const object = nearestGrip(game, a),
    station = nearestStation(game, a),
    door = nearbyDoor(game, a);
  if (
    object &&
    distance(a, surfacePoint(a, object)) <
      Math.min(
        station ? distance(a, station) : Infinity,
        door ? distance(a, doorFrame(door)) : Infinity,
      )
  )
    return `E · Grip ${objectName(object.kind).toLowerCase()}`;
  const e = station && game.encounters[station.encounter];
  const usable = !!e && !(e.mode === "solo" && e.owner && e.owner !== a.id);
  if (
    station &&
    (!door || (distance(a, station) < distance(a, doorFrame(door)) && usable))
  ) {
    if (e?.state === "consumed") return "Terminal complete";
    if (!usable) return "Terminal in use";
    return "E · Open terminal";
  }
  if (door?.field) return accessDoorPrompt(door, a);
  if (door?.door && !door.door.latched)
    return "Push to swing door · E near handle to grip";
  return door ? "E · Release door latch" : "";
}

export class FirstPersonHud {
  private run = "";
  private hp = 100;
  private damageUntil = 0;
  private lastPrompt = -Infinity;

  constructor(
    private root: HTMLElement,
    private prompt: HTMLElement,
    private hint: HTMLElement,
    private damage: HTMLElement,
  ) {
    this.hint.textContent =
      "Click to capture mouse · Move mouse to look · WASD move · Esc pauses";
  }

  update(
    game: Game,
    visible: boolean,
    locked: boolean,
    typing: boolean,
    now: number,
    yaw?: number,
  ) {
    const a = human(game);
    if (this.run !== game.id) {
      this.run = game.id;
      this.hp = a.hp;
      this.damageUntil = 0;
      this.lastPrompt = -Infinity;
    }
    if (visible && a.hp < this.hp && !game.settings.reducedFlash)
      this.damageUntil = now + 240;
    this.hp = a.hp;
    this.root.hidden = !visible;
    const showPrompt = visible && !typing && !game.paused;
    if (!showPrompt || now - this.lastPrompt >= 100) {
      const text = showPrompt ? interactionPrompt(game, yaw) : "";
      if (this.prompt.textContent !== text) this.prompt.textContent = text;
      this.prompt.hidden = !text;
      this.lastPrompt = showPrompt ? now : -Infinity;
    }
    this.hint.hidden = locked || typing || !!game.paused;
    this.damage.hidden =
      !visible || game.settings.reducedFlash || now >= this.damageUntil;
  }
}
