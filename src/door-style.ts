import type { DoorStyle, Furniture } from "./model";

/** Readable defaults for doors no run design has customised. */
const DOOR_PRESETS: DoorStyle[] = [
  {
    material: "wood",
    color: "#7a5230",
    accent: "#c9a26b",
    window: "none",
    label: "Oak office door",
  },
  {
    material: "wood",
    color: "#5f6b52",
    accent: "#d8d2bd",
    window: "slit",
    label: "Painted office door",
  },
  {
    material: "steel",
    color: "#5d6a75",
    accent: "#c7d0d6",
    window: "slit",
    label: "Steel service door",
  },
  {
    material: "steel",
    color: "#3f5364",
    accent: "#e0b64a",
    window: "none",
    label: "Steel utility door",
  },
  {
    material: "glass",
    color: "#38474f",
    accent: "#b9c6cc",
    window: "full",
    label: "Glass partition door",
  },
  {
    material: "fire",
    color: "#8c2f2a",
    accent: "#e8c547",
    window: "slit",
    label: "Fire door",
  },
  {
    material: "security",
    color: "#2f363d",
    accent: "#d9812f",
    window: "none",
    label: "Security door",
  },
];
function hash(text: string, seed: number) {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i++)
    h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0;
  return h;
}
/** Deterministic look for an undesigned door; world RNG is never consumed. */
export function presetDoorStyle(id: string, seed = 0): DoorStyle {
  return DOOR_PRESETS[hash(id, seed) % DOOR_PRESETS.length];
}
/** Older saves and lab fixtures have no stored look, so it comes from the id. */
export function doorStyle(o: Pick<Furniture, "id" | "doorStyle">): DoorStyle {
  return o.doorStyle ?? presetDoorStyle(o.id);
}
export function doorSeeThrough(style: DoorStyle) {
  return (
    style.material === "glass" ||
    style.window === "half" ||
    style.window === "full"
  );
}
export interface DoorLeafLayout {
  /** Hinge position along the door span, measured from its centre. */
  hinge: number;
  /** Direction the leaf extends from its hinge. */
  extend: 1 | -1;
  width: number;
}
/** One leaf for a narrow opening, then hinged pairs across wider ones. */
export function doorLeaves(span: number): DoorLeafLayout[] {
  const count = span <= 2.4 ? 1 : Math.max(2, Math.round(span / 2));
  const width = span / count;
  return Array.from({ length: count }, (_, i) => {
    const start = -span / 2 + i * width,
      extend: 1 | -1 = i % 2 === 0 ? 1 : -1;
    return {
      hinge: extend === 1 ? start : start + width,
      extend,
      width,
    };
  });
}
