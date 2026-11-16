import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { PRESETS } from "../../src/gametest/presets";
import { parseScenario, type Scenario } from "../../src/gametest/schema";
interface GameTestInput {
  source: string;
  scenario?: Scenario;
  error?: string;
}
export function readGameTest(source: string): GameTestInput {
  try {
    return { source, scenario: parseScenario(readFileSync(source, "utf8")) };
  } catch (error) {
    return { source, error: String(error) };
  }
}
/** Keep invalid fixtures visible without preventing independent cases from running. */
export function discoverGameTests(): GameTestInput[] {
  const root = fileURLToPath(
    new URL("../../tests/fixtures/gametest/", import.meta.url),
  );
  const files = existsSync(root)
    ? readdirSync(root)
        .filter((name) => name.endsWith(".json"))
        .sort()
    : [];
  if (files.length > 128) throw Error("Too many checked-in GameTest fixtures.");
  return [
    ...PRESETS.map((s) => ({
      source: `builtin:${s.id}`,
      scenario: structuredClone(s),
    })),
    ...files.map((name) => readGameTest(join(root, name))),
  ];
}
export function uniqueGameTests(inputs: GameTestInput[]): GameTestInput[] {
  const ids = new Set<string>();
  return inputs.map((input) => {
    const id = input.scenario?.id;
    if (!id) return input;
    if (ids.has(id))
      return { source: input.source, error: `Duplicate GameTest ID: ${id}` };
    ids.add(id);
    return input;
  });
}
/** Checked-in regressions also join the normal core suite; invalid fixtures fail loudly. */
export function loadGameTests(): Scenario[] {
  return uniqueGameTests(discoverGameTests()).map((input) => {
    if (!input.scenario)
      throw Error(`Invalid GameTest fixture ${input.source}: ${input.error}`);
    return input.scenario;
  });
}
