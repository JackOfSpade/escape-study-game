/**
 * Real geometry for a newly reached area (docs/ESCAPE_REDESIGN.md).
 *
 * An area otherwise reuses the seed-only generator, which makes every place an
 * office. This module runs the same quality-first AI pipeline a fresh run uses,
 * headlessly and with drafts kept in memory, so a rocket interior is built as a
 * rocket and a lighthouse as a lighthouse.
 *
 * Only the accepted `SavedRunDesign` is kept here. The playable game is built
 * on demand by `buildDesignedArea`, so a reload or a Restart always produces a
 * fresh area from the saved design instead of handing back a played game.
 */
import type { AreaStub } from "./escape-types";
import type { Game, Roadmap } from "./model";
import type { SavedRunDesign } from "./run-design-contract.mjs";
import type { DesignOptions } from "./run-designer";
import { newDesignDraft, prepareDesignedRun } from "./run-designer";
import {
  createPlayableGame,
  finalizeDesignedRun,
  previewDesignedRun,
} from "./world";

/** One design request, resolved with the answer or rejected. */
export type AreaSend = NonNullable<DesignOptions<Game>["send"]>;

export interface AreaDesignOptions {
  roadmap: Roadmap;
  signal: AbortSignal;
  send?: AreaSend;
}

/** A finished design: its accepted design and a game built from it. */
export interface AreaDesign {
  game: Game;
  saved: SavedRunDesign;
}

const clip = (value: string, max: number): string =>
  value.trim().slice(0, max).trim();

/** Build a fresh playable area from an accepted design (registered by main.ts). */
export function buildDesignedArea(
  seed: number,
  roadmap: Roadmap,
  saved: SavedRunDesign,
): Game {
  return createPlayableGame(seed, roadmap, undefined, saved);
}

/**
 * Design one area and build its playable `Game`.
 *
 * The draft never touches stored history: `capture` is a no-op, so a failed or
 * abandoned design leaves no trace behind.
 */
export async function designArea(
  stub: AreaStub,
  opts: AreaDesignOptions,
): Promise<AreaDesign> {
  const draft = newDesignDraft(`area-${stub.id}`, stub.seed, [], [], {
    name: clip(stub.plan?.name ?? stub.name, 60) || `Area ${stub.id}`,
    brief: clip(stub.plan?.premise ?? stub.brief, 600) || stub.brief,
  });
  // The pipeline builds a candidate from the design it just accepted; capture
  // that exact design so the caller can store it with the game.
  let accepted: SavedRunDesign | undefined;
  const result = await prepareDesignedRun<Game>(draft, {
    signal: opts.signal,
    ...(opts.send ? { send: opts.send } : {}),
    capture: () => {},
    build: (seed, saved) => {
      accepted = saved;
      return createPlayableGame(seed, opts.roadmap, undefined, saved);
    },
    preview: (seed, structure) =>
      previewDesignedRun(seed, opts.roadmap, undefined, structure),
    finalize: finalizeDesignedRun,
  });
  return { game: result.game, saved: accepted ?? result.saved };
}

/** Designs still running, and accepted designs, keyed by area id. */
const running = new Map<string, Promise<SavedRunDesign>>();
const designs = new Map<string, SavedRunDesign>();

/**
 * Start (or join) the design of one area.
 *
 * Concurrent callers for the same area share one promise, so a background
 * prefetch and the portal that reached it never design the same place twice.
 * The result is the accepted `SavedRunDesign`; the caller builds games from it.
 */
export function startAreaDesign(
  stub: AreaStub,
  opts: AreaDesignOptions,
): Promise<SavedRunDesign> {
  if (stub.design) return Promise.resolve(stub.design);
  const pending = running.get(stub.id);
  if (pending) return pending;
  const done = designs.get(stub.id);
  if (done) return Promise.resolve(done);
  const promise = designArea(stub, opts).then(
    ({ saved }) => {
      running.delete(stub.id);
      designs.set(stub.id, saved);
      return saved;
    },
    (error: unknown) => {
      running.delete(stub.id);
      throw error;
    },
  );
  running.set(stub.id, promise);
  return promise;
}

/** The saved design for an area, once its design resolved. */
export function areaDesignResult(stubId: string): SavedRunDesign | undefined {
  return designs.get(stubId);
}
