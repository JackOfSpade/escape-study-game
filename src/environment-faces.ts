import type { Furniture } from "./model";
import type { ResolvedSceneProp } from "./authored-scene";
import { furnitureHeightOf } from "./view3d/furniture-height";

/** Fractions of the catalog envelope, shared by visible labels and saved slots. */
export const PROP_LABEL_FACES: Partial<
  Record<string, { y: number; z: number; w: number; h: number }>
> = {
  mug: { y: 0.45, z: 0.453, w: 0.55, h: 0.36 },
  bottle: { y: 0.34, z: 0.485, w: 0.7, h: 0.3 },
  plant: { y: 0.19, z: 0.335, w: 0.5, h: 0.24 },
  lamp: { y: 0.04, z: 0.451, w: 0.6, h: 0.065 },
  trophy: { y: 0.08, z: 0.451, w: 0.7, h: 0.12 },
  headphones: { y: 0.9, z: 0.152, w: 0.25, h: 0.1 },
  photo: { y: 0.5, z: 0.39, w: 0.82, h: 0.79 },
};

/** Existing renderer convention: y is elevation and z is depth. */
export function furnitureLabelFace(host: Furniture) {
  const height = furnitureHeightOf(host),
    face = {
      y: height * 0.6,
      z: host.h / 2 + 0.004,
      w: Math.min(host.w * 0.7, 0.5),
      h: Math.min(height * 0.22, 0.15),
    };
  if (host.kind === "custom") {
    // On the front (+y) face of the frontmost solid box part, so the tag
    // sits on the object instead of floating before round or glass parts.
    const solid = (host.object?.parts ?? [])
      // Tags are centred across the object, so the part must span x = 0.
      .filter(
        (p) =>
          p.shape === "box" &&
          p.finish !== "glass" &&
          // A tilted or moving part has no steady front face to hold a tag.
          !p.pitch &&
          !p.roll &&
          (!p.motion || p.motion === "none") &&
          p.h >= 0.06 &&
          Math.abs(p.x) <= p.w / 2 - 0.05,
      )
      .sort((a, b) => b.y + b.d / 2 - (a.y + a.d / 2) || b.w - a.w)[0];
    if (solid) {
      face.y = solid.z + solid.h / 2;
      face.z = solid.y + solid.d / 2 + 0.004;
      face.w = Math.max(
        0.08,
        Math.min((solid.w / 2 - Math.abs(solid.x)) * 1.4, 0.5),
      );
      face.h = Math.max(0.03, Math.min(solid.h * 0.6, 0.15));
    } else {
      const depth = host.object?.size.d ?? host.h;
      face.y = Math.min(
        Math.max(height * 0.6, 0.1),
        Math.max(height - 0.06, 0.1),
      );
      face.z = depth / 2 + 0.004;
      face.w = Math.max(0.1, Math.min(host.w * 0.6, 0.5));
      face.h = Math.max(0.04, Math.min(height * 0.2, 0.15));
    }
  } else if (
    [
      "desk",
      "table",
      "cafeTable",
      "coffeeTable",
      "reception",
      "chair",
      "officeChair",
      "armchair",
      "sofa",
    ].includes(host.kind)
  ) {
    face.y = height;
    face.h = 0.075;
  } else if (host.kind === "shelf") {
    face.y = height + 0.08;
    face.h = 0.05;
  } else if (host.kind === "plant") {
    face.y = 0.22;
    face.z = host.h * 0.325 + 0.004;
    face.w = Math.min(host.w * 0.5, 0.5);
  } else if (["screen", "whiteboard", "partition"].includes(host.kind)) {
    face.y = height * 0.45;
    face.z =
      host.kind === "partition" ? host.h / 2 + 0.004 : host.h * 0.52 + 0.03;
  } else if (host.kind === "cooler") {
    face.y = 0.4;
    face.z = host.h * 0.425 + 0.004;
  } else if (host.kind === "printer") {
    face.y = 0.83;
    face.z = host.h * 0.51 + 0.022;
  } else if (host.kind === "microwave") {
    face.y = 0.85;
    face.z = host.h * 0.51 + 0.022;
  } else if (host.kind === "box") {
    face.y = height * 0.55;
    face.z = host.h * 0.51 + 0.018;
  } else if (host.kind === "mixingConsole" || host.kind === "turntable") {
    // Turntable pull handles sit at 0.4 m, so its label rides above them.
    face.y = host.kind === "turntable" ? 0.58 : 0.35;
    face.h = 0.1;
  } else if (host.kind === "micStand") {
    face.y = 0.03;
    face.z = Math.min(host.w, host.h) * 0.4 + 0.004;
    face.w = Math.min(host.w, host.h) * 0.5;
    face.h = 0.045;
  } else if (host.kind === "recordShelf") {
    face.y = height - 0.02;
    face.h = 0.035;
  } else if (host.kind === "studioMonitor") {
    // The woofer plates stand proud of the cabinet, so the label sits on them.
    face.y = 1.1;
    face.z = host.h * 0.4 + 0.032;
    face.w = Math.min(host.w * 0.32, 0.17);
    face.h = 0.05;
  } else if (host.kind === "equipmentRack") {
    face.y = 1.88;
    face.z = host.h / 2 + 0.014;
    face.w = Math.min(host.w * 0.6, 0.5);
    face.h = 0.07;
  } else if (host.kind === "soundPanel") {
    face.y = height * 0.55;
    face.z = Math.min(host.h * 0.45, 0.1) / 2 + 0.016;
    face.h = 0.15;
  } else if (host.kind === "onAirLight") {
    // The glowing lightbox face carries the authored text.
    face.y = 1.95;
    face.z = host.h * 0.275 + 0.016;
    face.w = host.w * 0.8;
    face.h = 0.16;
  } else if (host.kind === "reelToReel") {
    // Below and between the cabinet's two front pulls (at 0.4 m, ±0.12..0.28).
    face.y = 0.2;
    face.z = host.h * 0.45 + 0.004;
    face.w = 0.22;
    face.h = 0.1;
  }
  return face;
}

/** A design-invented prop reads on the top or front face of its largest solid
 * box that never tilts or moves, else on the top of its envelope. Parts are in
 * the recipe frame (x across, y back to front, z up), scaled by the placement. */
function composedPropFace(prop: ResolvedSceneProp) {
  const s = prop.scale,
    solid = (prop.object?.parts ?? [])
      .filter(
        (p) =>
          p.shape === "box" &&
          p.pitch === 0 &&
          p.roll === 0 &&
          p.motion === "none" &&
          p.finish !== "glass" &&
          p.finish !== "glow" &&
          p.w * s >= 0.03 &&
          Math.min(p.d, p.h) * s >= 0.012,
      )
      .sort((a, b) => b.w * b.d * b.h - a.w * a.d * a.h)[0];
  if (!solid)
    return {
      x: 0,
      y: 0,
      z: prop.h + 0.002,
      width: prop.w * 0.76,
      height: prop.d * 0.78,
      yaw: 0,
      pitch: -Math.PI / 2,
    };
  // A top covered by another part (a lid, a flame, a lens) cannot be read.
  const covered = (prop.object?.parts ?? []).some(
      (o) =>
        o !== solid &&
        o.z + o.h > solid.z + solid.h + 0.004 &&
        o.z < solid.z + solid.h + 0.2 &&
        Math.abs(o.x - solid.x) < (o.w + solid.w) / 2 - 0.01 &&
        Math.abs(o.y - solid.y) < (o.d + solid.d) / 2 - 0.01,
    ),
    top = covered ? 0 : solid.w * solid.d,
    front = solid.w * solid.h;
  return front > top
    ? {
        x: solid.x * s,
        y: (solid.y + solid.d / 2) * s + 0.002,
        z: (solid.z + solid.h / 2) * s,
        width: solid.w * s * 0.86,
        height: solid.h * s * 0.7,
        yaw: 0,
        pitch: 0,
      }
    : {
        x: solid.x * s,
        y: solid.y * s,
        z: (solid.z + solid.h) * s + 0.002,
        width: solid.w * s * 0.86,
        height: solid.d * s * 0.86,
        yaw: 0,
        pitch: -Math.PI / 2,
      };
}

/** Game coordinates: x/y are horizontal, z is elevation, local to the prop. */
export function propSurfaceFace(prop: ResolvedSceneProp) {
  if (prop.object) return composedPropFace(prop);
  const face = PROP_LABEL_FACES[prop.kind];
  return {
    x: prop.kind === "mug" ? -prop.w * 0.08 : 0,
    y: face ? prop.d * face.z : 0,
    z: face ? prop.h * face.y : prop.h * 0.985,
    width: prop.w * (face ? face.w : 0.76),
    height: face ? prop.h * face.h : prop.d * 0.78,
    yaw: 0,
    pitch: face ? 0 : -Math.PI / 2,
  };
}

/** Actual writing face above the ownership tag, local to its movable board. */
export function furnitureBoardFace(host: Furniture) {
  const height = furnitureHeightOf(host);
  return {
    x: 0,
    y: host.h * 0.52 + 0.045,
    z: height * 0.65,
    width: host.w * 0.89,
    height: height * 0.56,
    yaw: 0,
    pitch: 0,
  };
}
