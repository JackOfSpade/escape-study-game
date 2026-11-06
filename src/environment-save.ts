import { furnitureSpec, type Game, type Floor } from "./model";
import type {
  EnvironmentManifest,
  SurfaceSlot,
} from "./environment-contract.mjs";
import {
  environmentSurfaceFingerprint,
  parseSavedRunDesign,
} from "./run-design-contract.mjs";
import {
  furnitureBoardFace,
  furnitureLabelFace,
  propSurfaceFace,
} from "./environment-faces";
import { cityWall } from "./city-layout";
import { PROP_CATALOG } from "./scene-catalog.mjs";
import { streetLayout } from "./view3d/exterior-layout";

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map((key) => [key, x[key]]),
        )
      : x,
  );
}
function same(a: unknown, b: unknown) {
  return canonical(a) === canonical(b);
}
function floorManifest(
  environment: EnvironmentManifest,
  floor: number,
): EnvironmentManifest {
  const surfaces = environment.surfaces.filter((s) => s.floor === floor),
    ids = new Set(surfaces.map((s) => s.id));
  return {
    ...environment,
    surfaces,
    entries: environment.entries.filter((e) => ids.has(e.surfaceId)),
  };
}
function requireThat(condition: unknown, message: string): asserts condition {
  if (!condition) throw Error(`Invalid saved environment: ${message}`);
}
function numbersMatch(source: object, b: Record<string, unknown>) {
  const a = source as Record<string, unknown>;
  return Object.entries(b).every(([key, value]) =>
    typeof value === "number"
      ? typeof a[key] === "number" &&
        Math.abs((a[key] as number) - value) < 1e-8
      : a[key] === value,
  );
}

function validateBinding(floor: Floor, slot: SurfaceSlot) {
  const b = slot.binding;
  if (b.kind !== "fixed") {
    const hosts = floor.furniture.filter((f) => f.id === b.furnitureId);
    requireThat(hosts.length <= 1, `duplicate host ${b.furnitureId}`);
    const host = hosts[0];
    // Engine destruction and lab captures may remove a native object entirely.
    // The immutable inventory retains its identity; its surface simply hides.
    if (!host) return;
    requireThat(
      [host.x, host.y, host.angle ?? 0, host.w, host.h].every(Number.isFinite),
      `invalid host pose ${host.id}`,
    );
    if (b.kind === "prop") {
      const prop = floor.scene?.props.find(
        (p) => p.id === b.propId && p.furnitureId === b.furnitureId,
      );
      requireThat(prop, `unbound prop ${b.propId}`);
      requireThat(
        numbersMatch(b, propSurfaceFace(prop)),
        `prop face differs from its physical support ${slot.id}`,
      );
    } else if (slot.role === "furniture-whiteboard") {
      requireThat(
        host.kind === "whiteboard" && numbersMatch(b, furnitureBoardFace(host)),
        `invalid whiteboard face ${slot.id}`,
      );
    } else if (slot.role === "furniture-label") {
      const f = furnitureLabelFace(host);
      requireThat(
        !!host.appearance &&
          numbersMatch(b, {
            x: 0,
            y: f.z,
            z: f.y,
            width: f.w,
            height: f.h,
            yaw: 0,
            pitch: 0,
          }),
        `invalid native label face ${slot.id}`,
      );
    }
    return;
  }
  if (
    ["wall-poster", "wall-whiteboard", "graffiti", "room-plaque"].includes(
      slot.role,
    )
  ) {
    const nx = Math.round(-Math.sin(b.yaw)),
      ny = Math.round(Math.cos(b.yaw));
    requireThat(
      Math.abs(nx) + Math.abs(ny) === 1 && b.pitch === 0,
      `invalid wall normal ${slot.id}`,
    );
    const wx = Math.floor(b.x - nx * 0.025),
      wy = Math.floor(b.y - ny * 0.025),
      ox = Math.floor(b.x + nx * 0.2),
      oy = Math.floor(b.y + ny * 0.2);
    requireThat(
      !!floor.tiles[wy]?.[wx] && floor.tiles[oy]?.[ox] === 0,
      `floating wall surface ${slot.id}`,
    );
    if (slot.role === "room-plaque") {
      const plaque = floor.scene?.rooms.find(
        (r) => r.room === slot.room,
      )?.plaque;
      requireThat(
        plaque &&
          numbersMatch(b, {
            x: plaque.x,
            y: plaque.y,
            z: 1.65,
            width: 1.12,
            height: 0.5,
            yaw: -Math.atan2(plaque.nx, plaque.ny),
          }),
        `invalid room plaque ${slot.id}`,
      );
    }
  } else if (slot.role === "storefront-sign" || slot.role === "street-sign") {
    const nx = Math.round(-Math.sin(b.yaw)),
      ny = Math.round(Math.cos(b.yaw));
    requireThat(
      slot.floor === 0 &&
        !!floor.city &&
        cityWall(floor, b.x - nx * 0.2, b.y - ny * 0.2) === true &&
        cityWall(floor, b.x + nx * 0.2, b.y + ny * 0.2) === false,
      `floating city sign ${slot.id}`,
    );
  } else if (slot.role === "building-sign") {
    const layout = streetLayout(floor);
    requireThat(
      layout &&
        numbersMatch(b, {
          x: layout.entrance,
          y: layout.front + 1.025 + 0.56,
          z: 3.22,
          width: 3.55,
          height: 0.74,
          yaw: 0,
          pitch: 0,
        }),
      `invalid building fascia ${slot.id}`,
    );
  } else if (slot.role === "quarantine-sign") {
    const entrance =
      floor.furniture.find((o) => o.id === "main-gate")?.initial?.x ??
      floor.furniture.find((o) => o.id === "main-gate")?.x ??
      22;
    requireThat(
      floor.boundary &&
        numbersMatch(b, {
          x: entrance + 4,
          y: floor.boundary.bottom + 1.06,
          z: 1.8,
          width: 3.2,
          height: 0.65,
          yaw: 0,
          pitch: 0,
        }),
      `invalid quarantine sign ${slot.id}`,
    );
  }
}

/** Validate the original saved manifest, never re-select decorations from the
 * player's changed furniture arrangement. Full canonical content is required. */
export function assertDesignedEnvironment(game: Game) {
  const saved = game.design ? parseSavedRunDesign(game.design) : undefined;
  if (!saved)
    requireThat(
      !game.floors.some((f) => f.design || f.exteriorDesign),
      "authored geometry is missing its complete accepted run design",
    );
  if (saved?.design.version !== 3) {
    requireThat(
      !game.floors.some((f) => f.environment),
      "environment content on a historical or procedural run",
    );
    return;
  }
  const environment = saved.design.environment;
  requireThat(
    environmentSurfaceFingerprint(environment.surfaces) ===
      environment.surfaceFingerprint,
    "surface fingerprint mismatch",
  );
  for (const floor of game.floors)
    requireThat(
      same(floor.environment, floorManifest(environment, floor.index)),
      `floor ${floor.index} manifest differs from the accepted run`,
    );
  for (const slot of environment.surfaces) {
    const floor = game.floors[slot.floor];
    requireThat(
      floor && floor.index === slot.floor,
      `missing floor for ${slot.id}`,
    );
    validateBinding(floor, slot);
  }
}

/** Call only after complete v3 acceptance, or after validating a loaded save. */
export function bindDesignedEnvironment(game: Game) {
  if (game.design?.design.version !== 3) return;
  const design = game.design.design,
    environment: EnvironmentManifest = design.environment;
  for (const floor of game.floors) {
    floor.environment = floorManifest(environment, floor.index);
    if (design.floors[floor.index]) floor.design = design.floors[floor.index];
    if (floor.index === 0) floor.exteriorDesign = design.exterior;
    if (design.setting) floor.setting = design.setting;
    else delete floor.setting;
  }
  rebindComposedObjects(game);
  assertDesignedEnvironment(game);
}

/** A composed object's recipe always comes from the accepted design: the save
 * only names which one it is. Replaces a tampered recipe with the canonical
 * one, restores its engine-owned size, and rejects an unknown id. */
export function rebindComposedObjects(game: Game) {
  const design = game.design?.design,
    objects = (design && "setting" in design && design.setting?.objects) || [];
  const props = (design && "setting" in design && design.setting?.props) || [];
  for (const floor of game.floors) {
    // A composed tabletop prop's recipe is rebound the same way.
    for (const p of floor.scene?.props ?? []) {
      if (Object.hasOwn(PROP_CATALOG, p.kind)) {
        delete p.object;
        continue;
      }
      const recipe = props.find((r) => r.id === p.kind);
      if (!recipe)
        throw Error(
          `Saved prop ${p.id} names a prop that is not in the run design`,
        );
      p.object = structuredClone(recipe);
    }
    for (const o of floor.furniture) {
      if (o.kind !== "custom") {
        delete o.object;
        continue;
      }
      const recipe = objects.find(
        (r) => r.id === (o.object as { id?: unknown } | undefined)?.id,
      );
      if (!recipe)
        throw Error(
          `Saved furniture ${o.id} names an object that is not in the run design`,
        );
      o.object = structuredClone(recipe);
      const spec = furnitureSpec(o);
      o.w = spec.w;
      o.h = spec.h;
      o.maxHp = spec.hp;
      o.hp = Math.min(o.hp, spec.hp);
    }
  }
}
