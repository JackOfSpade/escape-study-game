import { sha256 } from "./digest";
import { finalRequirements } from "./final-requirements";
import type { Objective, Roadmap, Track } from "./model";
import { readIdentifierCounters } from "./roadmap-identifiers";
import { inspectMergedDocument } from "./roadmap-structure";
import { CELL_SEPARATOR } from "./table-row";
const validDay = (value: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 10) === value;
const protectedNames = ["MERGE_RULES", "PY_CURRICULUM", "PE_CURRICULUM"];
function part(raw: string, heading: string) {
  const marker = `### ${heading}\n`,
    a = raw.indexOf(marker);
  if (a < 0) throw Error(`Missing source section ${heading}`);
  return raw.slice(a + marker.length).split("\n### ")[0];
}
function field(raw: string, label: string) {
  const rows = raw.split("\n").filter((l) => l.startsWith(`| ${label} |`));
  if (rows.length !== 1)
    throw Error(`Missing or ambiguous saved field ${label}`);
  const c = rows[0]
    .split(CELL_SEPARATOR)
    .slice(1, -1)
    .map((c) => c.trim());
  if (c.length !== 2) throw Error(`Malformed saved field ${label}`);
  return c[1];
}
const cells = (line: string) =>
  line
    .split(CELL_SEPARATOR)
    .slice(1, -1)
    .map((c) => c.trim());
/** Parse an entire saved document without adopting its claims or starting study.
 * Routine changes must preserve both protected digests and the surrounding contract. */
export async function parseRoadmapDocument(
  raw: string,
  baseline?: Roadmap,
): Promise<Roadmap> {
  if (
    typeof raw !== "string" ||
    new TextEncoder().encode(raw).length > 2_000_000
  )
    throw Error("Roadmap exceeds the 2 MB document limit");
  const parsed = inspectMergedDocument(raw),
    revision = parsed.revision;
  if (
    revision < 1 ||
    parsed.previous !== revision - 1 ||
    !validDay(parsed.field("updated_on")) ||
    !/^[a-f0-9]{64}$/.test(parsed.field("parent_file_sha256"))
  )
    throw Error("Invalid saved revision, date or parent metadata");
  for (const name of protectedNames) {
    if (
      (await sha256(parsed.blocks[name])) !==
      parsed.field(`${name.toLowerCase()}_sha256`)
    )
      throw Error(`Digest mismatch for ${name}`);
  }
  if (baseline) {
    if ((await sha256(baseline.raw)) !== baseline.sourceHash)
      throw Error("Baseline document integrity failure");
    const original = inspectMergedDocument(baseline.raw);
    for (const name of protectedNames)
      if (parsed.blocks[name] !== original.blocks[name])
        throw Error(
          `Protected ${name} changed; explicit policy migration required`,
        );
    const frame = (text: string) => {
      const p = inspectMergedDocument(text);
      for (const name of ["SHARED_PROGRESS", "PY_PROGRESS", "PE_PROGRESS"])
        text = text.replace(
          `<!-- BEGIN ${name} -->\n${p.blocks[name]}<!-- END ${name} -->`,
          `<!-- BEGIN ${name} -->\n<!-- END ${name} -->`,
        );
      const end = text.indexOf("\n---\n", 4);
      return (
        text
          .slice(0, end)
          .replace(
            /^(revision|previous_revision|parent_file_sha256|updated_on): .+$/gm,
            "$1: (saved metadata)",
          ) + text.slice(end)
      );
    };
    if (frame(raw) !== frame(baseline.raw))
      throw Error(
        "Operating contract or immutable file envelope changed; explicit policy migration required",
      );
  }
  const tracks = {} as Roadmap["tracks"];
  for (const t of ["PY", "PE"] as Track[]) {
    const progress = "\n" + parsed.blocks[`${t}_PROGRESS`],
      curriculum = "\n" + parsed.blocks[`${t}_CURRICULUM`];
    const curriculumLines = curriculum.split("\n");
    const objectives: Objective[] = part(
      progress,
      "0.4 Objective checkpoint ledger",
    )
      .split("\n")
      .filter((l) => /^\| [TX]\d{2}\.\d+ \|/.test(l))
      .map((l) => {
        const c = cells(l),
          id = c[0],
          target = Number(c[1]?.slice(1));
        if (
          c.length !== 9 ||
          !/^D[1-4]$/.test(c[1]) ||
          c
            .slice(2, 6)
            .some(
              (v, i) =>
                !(i < target ? ["U", "G", "P", "R"] : ["—"]).includes(v),
            )
        )
          throw Error(`Malformed objective checkpoint ${t}:${id}`);
        const def = curriculumLines.find((l) => l.startsWith(`| ${id} |`));
        const extension = curriculumLines.find((l) => l.includes(`**${id}**`));
        const scope =
          def?.split(CELL_SEPARATOR)[2].trim() ??
          extension
            ?.split(CELL_SEPARATOR)[3]
            ?.split(`**${id}**`)[1]
            ?.split(/\*\*[TX]\d{2}\.\d+\*\*/)[0]
            ?.trim();
        if (!scope || scope.length < 20)
          throw Error(`Missing authoritative objective definition ${t}:${id}`);
        return {
          id: `${t}:${id}`,
          target,
          cells: c.slice(2, 6),
          route: c[6],
          refs: c[7],
          reviewDue: /\d{4}-\d{2}-\d{2}/.exec(c[8])?.[0] ?? null,
          scope,
        };
      });
    if (
      objectives.length !== (t === "PY" ? 80 : 112) ||
      new Set(objectives.map((o) => o.id)).size !== objectives.length
    )
      throw Error(`Incomplete or duplicate ${t} objective roster`);
    if (
      baseline &&
      JSON.stringify(objectives.map((o) => [o.id, o.target, o.scope])) !==
        JSON.stringify(
          baseline.tracks[t].objectives.map((o) => [o.id, o.target, o.scope]),
        )
    )
      throw Error(
        `Changed ${t} objective selection, order, target or scope; explicit scope migration required`,
      );
    const resume = part(progress, "0.2 Breadth scheduler and resume packet"),
      active =
        /^Tier ([1-4]) \/ (DIAGNOSE_ALL|REPAIR_VERIFY|TIER_GATE|COMPLETE)(?:\b|$)/.exec(
          field(resume, "Active tier / phase"),
        );
    const lap = /\bL(\d+)\b/.exec(field(resume, "Active wave / lap"));
    if (
      !active ||
      !lap ||
      !Number.isSafeInteger(Number(lap[1])) ||
      Number(lap[1]) < 1
    )
      throw Error(`Malformed ${t} tier, phase or lap`);
    const rotationText = field(resume, "Default topic rotation")
        .split(/[;(]/)[0]
        .trim(),
      queueText = field(resume, "Remaining topics in current lap")
        .split(/[;(]/)[0]
        .trim();
    if (
      !/^[TX]\d{2}(?:,\s*[TX]\d{2})*$/.test(rotationText) ||
      (!["None", "—"].includes(queueText) &&
        !/^[TXI]\d{2}(?:,\s*[TXI]\d{2})*$/.test(queueText))
    )
      throw Error(`Malformed ${t} breadth rotation or remaining queue`);
    const rotation: string[] = rotationText.split(/,\s*/),
      remaining: string[] = ["None", "—"].includes(queueText)
        ? []
        : queueText.split(/,\s*/);
    const topics = Object.fromEntries(
      [...curriculum.matchAll(/^### ([TX]\d{2}) — (.+)$/gm)].map((m) => [
        m[1],
        m[2],
      ]),
    );
    for (const l of curriculumLines.filter((l) => /^\| X\d{2} /.test(l))) {
      const c = cells(l),
        id = /^X\d{2}/.exec(c[0])?.[0];
      if (id) topics[id] = c[0].split(" — ").slice(1).join(" — ");
    }
    const roster = [
      ...new Set(objectives.map((o) => o.id.split(":")[1].split(".")[0])),
    ];
    if (
      new Set(rotation).size !== rotation.length ||
      rotation.length !== roster.length ||
      roster.some((id) => !rotation.includes(id)) ||
      rotation.some((id) => !topics[id]) ||
      new Set(remaining).size !== remaining.length
    )
      throw Error(`Malformed ${t} breadth rotation or remaining queue`);
    const board = part(progress, "0.2.1 Tier and gate board")
      .split("\n")
      .filter((l) => /^\| Tier [1-4] /.test(l))
      .map(cells);
    let cleared = 0;
    if (board.length !== 4) throw Error(`Incomplete ${t} tier gate board`);
    for (let depth = 1; depth <= 4; depth++) {
      const row = board.find((c) => c[0].startsWith(`Tier ${depth} `));
      if (!row) throw Error(`Missing ${t} gate ${depth}`);
      if (row[3].startsWith("CLEARED")) {
        if (
          cleared !== depth - 1 ||
          objectives.some(
            (o) => o.target >= depth && o.cells[depth - 1] !== "P",
          )
        )
          throw Error(`Unsupported ${t} cleared tier ${depth}`);
        cleared = depth;
      }
    }
    const dashboard = part(progress, "0.1 Learner profile and dashboard"),
      stated = /^(\d+)\/(\d+)/.exec(
        field(dashboard, "Required checkpoint passes"),
      );
    const total = objectives.reduce((n, o) => n + o.target, 0),
      passed = objectives.reduce(
        (n, o) =>
          n + o.cells.slice(0, o.target).filter((v) => v === "P").length,
        0,
      );
    if (!stated || Number(stated[1]) !== passed || Number(stated[2]) !== total)
      throw Error(
        `${t} dashboard checkpoint counts contradict its objective ledger`,
      );
    if (
      objectives.some(
        (o) => o.cells.includes("P") && (!o.refs || o.refs === "—"),
      )
    )
      throw Error(`${t} checkpoint pass lacks source evidence references`);
    const tier = Number(active[1]),
      phase = active[2];
    if (
      cleared < tier - 1 ||
      (phase === "COMPLETE" && (tier !== 4 || cleared !== 4))
    )
      throw Error(`Saved ${t} tier exceeds its cleared lower gates`);
    tracks[t] = {
      tier,
      phase,
      lap: Number(lap[1]),
      cleared,
      remaining,
      rotation,
      objectives,
      topics,
      progress,
      curriculum,
    };
  }
  const result: Roadmap = {
    documentId: "interview_prep_roadmap",
    revision,
    sourceHash: await sha256(raw),
    raw,
    tracks,
    sharedProgress: "\n" + parsed.blocks.SHARED_PROGRESS,
  };
  // Parsed once per track: the retention table below consults it per row.
  const finals = {} as Record<Track, ReturnType<typeof finalRequirements>>;
  for (const t of ["PY", "PE"] as Track[]) {
    const s = tracks[t],
      other = tracks[t === "PY" ? "PE" : "PY"];
    if (s.tier > (other.cleared ?? 0) + 2)
      throw Error(`${t} exceeds the cross-track tier-lead limit`);
    const sharedRow = part(result.sharedProgress, "S0.1 Unified dashboard")
      .split("\n")
      .find((l) => l.startsWith(`| ${t} |`));
    const c = sharedRow ? cells(sharedRow) : [],
      summary = /^(\d+)\/(\d+)/.exec(c[3] ?? "");
    const total = s.objectives.reduce((n, o) => n + o.target, 0),
      passed = s.objectives.reduce(
        (n, o) =>
          n + o.cells.slice(0, o.target).filter((v) => v === "P").length,
        0,
      );
    if (
      !summary ||
      Number(summary[1]) !== passed ||
      Number(summary[2]) !== total ||
      !c[1]?.startsWith(`Tier ${s.tier} / ${s.phase}`)
    )
      throw Error(`Shared ${t} dashboard contradicts track state`);
    const defs = (finals[t] = finalRequirements(result, t)),
      allowed = [
        ...s.rotation,
        ...defs
          .filter((d) => d.kind === "integration" && d.selected)
          .map((d) => d.name),
      ];
    if (
      s.remaining.some((id) => !allowed.includes(id)) ||
      s.remaining.some(
        (id, i) =>
          i > 0 && allowed.indexOf(id) < allowed.indexOf(s.remaining[i - 1]),
      )
    )
      throw Error(`Unknown or out-of-order ${t} remaining queue`);
    if (
      s.phase === "COMPLETE" &&
      defs.some(
        (d) => d.kind !== "environment" && d.selected && d.status !== "P",
      )
    )
      throw Error(`${t} completion lacks transfer or integration proof`);
  }
  const packet = part(
      result.sharedProgress,
      "S0.2 Shared scheduler and resume packet",
    ),
    next = field(packet, "Next track in alternation"),
    issues: string[] = [];
  let position: number | undefined;
  const explicit = /\bpattern position ([0-2])\b/.exec(next),
    legacy =
      /(\d+) additional served visit\(s\) since source revision (\d+)/.exec(
        next,
      );
  if (/\bpattern position\b/.test(next) && !explicit)
    throw Error("Invalid saved ratio position");
  if (legacy && !Number.isSafeInteger(Number(legacy[1])))
    throw Error("Saved ratio counter exceeds safe integer range");
  if (explicit) position = Number(explicit[1]);
  else if (
    legacy &&
    baseline?.resume?.ratioPosition !== undefined &&
    Number(legacy[2]) === baseline.revision
  )
    position = (baseline.resume.ratioPosition + Number(legacy[1])) % 3;
  else if (/^PY(?:\b|;)/.test(next)) position = 0;
  if (position === undefined)
    issues.push(
      "Saved next PE turn does not distinguish the first and second PE visits; reconcile actual primary visits before resuming the ratio.",
    );
  else if (
    (["PY", "PE", "PE"] as const)[position] !== /^(PY|PE)\b/.exec(next)?.[1]
  )
    throw Error("Saved ratio position contradicts its next track");
  const reviews: NonNullable<Roadmap["resume"]>["reviews"] = {};
  for (const t of ["PY", "PE"] as Track[]) {
    const supplement = tracks[t].progress.includes(
      "### 0.12 Game semantic scope and continuation state\n",
    )
      ? part(
          tracks[t].progress,
          "0.12 Game semantic scope and continuation state",
        )
      : "";
    if (
      supplement &&
      (!supplement.includes("| Review scope | Stage | Due |") ||
        !supplement.includes("| Suspended state | Tier | Phase |"))
    )
      issues.push(
        `${t} legacy exported progress lacks exact retention or suspended-queue metadata; reconcile before resuming.`,
      );
    const table = (header: string) => {
      const start = supplement.indexOf(header);
      if (start < 0) return [];
      return supplement
        .slice(start)
        .split("\n\n")[0]
        .split("\n")
        .slice(2)
        .filter((l) => l.startsWith("|"))
        .map(cells);
    };
    for (const c of table(
      "| Review scope | Stage | Due | Last independent at | Last independent date | Sequence | Verified reviews |",
    )) {
      const key =
          /^(PY|PE):([TX]\d{2}(?:\.\d+)?|I\d{2})\/(?:D([1-4])|T(4))$/.exec(
            c[0],
          ),
        stage = Number(c[1]),
        verified = Number(c[6]);
      const id = key ? `${key[1]}:${key[2]}` : "",
        depth = Number(key?.[3] ?? key?.[4]),
        o = tracks[t].objectives.find((o) => o.id === id),
        final = finals[t].find(
          (d) => d.id === id && d.kind !== "environment" && d.selected,
        );
      if (
        c.length !== 7 ||
        !key ||
        key[1] !== t ||
        (!o && !final) ||
        (!!o && !!key[4]) ||
        (!o && !!key[3]) ||
        (o && depth > o.target) ||
        !/^\d+$/.test(c[1]) ||
        stage > 2 ||
        !/^\d+$/.test(c[6]) ||
        !Number.isSafeInteger(verified) ||
        verified < 0 ||
        !validDay(c[2]) ||
        (c[3] !== "—" &&
          (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
            c[3],
          ) ||
            !validDay(c[3].slice(0, 10)) ||
            !Number.isFinite(Date.parse(c[3])))) ||
        (c[4] !== "—" && !validDay(c[4]))
      )
        throw Error(`Malformed saved retention state ${c[0]}`);
      reviews[c[0]] = {
        objectiveId: id,
        depth,
        stage,
        due: c[2],
        verifiedReviews: verified,
        ...(c[3] !== "—" ? { lastIndependentAt: c[3] } : {}),
        ...(c[4] !== "—" ? { lastIndependentDate: c[4] } : {}),
        ...(c[5] !== "—" ? { sequence: c[5] } : {}),
      };
    }
    const allowed = [
      ...tracks[t].rotation,
      ...finals[t]
        .filter((d) => d.kind === "integration" && d.selected)
        .map((d) => d.name),
    ];
    tracks[t].suspended = table(
      "| Suspended state | Tier | Phase | Lap | Queue |",
    ).map((c) => {
      const tier = Number(c[1]),
        lap = c[3] === "—" ? undefined : Number(c[3]),
        queue = c[4] === "—" ? [] : c[4].split(", ");
      if (
        c.length !== 5 ||
        !Number.isInteger(tier) ||
        tier <= tracks[t].tier ||
        tier > 4 ||
        !["DIAGNOSE_ALL", "REPAIR_VERIFY", "TIER_GATE", "COMPLETE"].includes(
          c[2],
        ) ||
        (lap !== undefined && (!Number.isSafeInteger(lap) || lap < 1)) ||
        new Set(queue).size !== queue.length ||
        queue.some((id) => !allowed.includes(id))
      )
        throw Error("Malformed suspended breadth queue");
      return {
        tier,
        phase: c[2],
        queue,
        ...(lap !== undefined ? { lap } : {}),
      };
    });
  }
  // Evidence cites a task from its own track's register: a PE row naming a
  // PY task (or the reverse) would attach evidence to the wrong track.
  const issued: Record<Track, Set<string>> = { PY: new Set(), PE: new Set() };
  for (const t of ["PY", "PE"] as Track[])
    for (const row of part(tracks[t].progress, "0.5.1 Attempt status register")
      .split("\n")
      .filter((s) => /^\| S\d/.test(s))) {
      const c = cells(row),
        state = /^([A-Z-]+)\b/.exec(c[3])?.[1];
      // Older exports used engine labels. Read them without rewriting
      // history; every newly projected task uses the curriculum's dispositions.
      if (
        c.length !== 6 ||
        ![
          "PENDING",
          "PARTIAL",
          "COMPLETED",
          "DECLINED",
          "SUPERSEDED",
          "INVALIDATED",
          "IN-PROGRESS",
          "SERVED",
          "INTERRUPTED",
          "SUSPENDED",
        ].includes(state ?? "")
      )
        throw Error(
          "Invalid source attempt disposition; completion is not a mastery score",
        );
      issued[t].add(c[0]);
    }
  for (const t of ["PY", "PE"] as Track[])
    for (const row of part(
      tracks[t].progress,
      "0.5 Assessment evidence register",
    )
      .split("\n")
      .filter((s) => /^\| S\d/.test(s)))
      if (!issued[t].has(cells(row)[1]))
        throw Error(
          issued[t === "PY" ? "PE" : "PY"].has(cells(row)[1])
            ? `${t} evidence cites an assessment task issued on the other track: ${cells(row)[1]}`
            : "Source evidence does not reference an issued assessment task",
        );
  const identifiers = readIdentifierCounters(raw);
  if (identifiers.issue) issues.push(identifiers.issue);
  result.resume = {
    ratioPosition: position,
    issues,
    identifierCounters: identifiers.counters,
    ...(Object.keys(reviews).length ? { reviews } : {}),
  };
  const ids = new Set<string>();
  for (const t of ["PY", "PE"] as Track[])
    for (const line of part(
      tracks[t].progress,
      "0.5 Assessment evidence register",
    )
      .split("\n")
      .filter((l) => /^\| S\d{4}-EV\d+ \|/.test(l))) {
      const id = cells(line)[0];
      if (ids.has(id))
        throw Error(`Evidence identifier reused across tracks: ${id}`);
      ids.add(id);
    }
  return result;
}
