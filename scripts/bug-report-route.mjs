import { HttpInputError, readJsonBody } from "./http-json.mjs";
import {
  closeSync,
  fstatSync,
  openSync,
  readdirSync,
  readSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { privateDirectory } from "./lib/private-fs.mjs";
import { isRecord } from "./lib/is-record.mjs";

/** A learner-filed bug report: what the browser collected plus this computer's
 * service logs, written to one Markdown file. The clipboard only ever carries
 * the file's path and the learner's own words, so an assistant reads the report
 * from disk in pieces rather than receiving it pasted whole. */
export const REPORT_LIMITS = {
  /** Newest reports kept; older ones are removed on every write. */
  retention: 20,
  maxAgeMs: 7 * 24 * 60 * 60 * 1000,
  description: 20_000,
  client: 1_500_000,
  /** Bytes read from the end of each service log. */
  logTail: 48_000,
  logLines: 120,
  usageRows: 60,
};
// Only files of this shape are ever pruned from the report folder.
const REPORT_FILE = /^bug-report-[\dTZ-]+(?:-\d+)?\.md$/;

/** The end of a text file, without reading a multi-megabyte log whole. */
function tail(path, bytes) {
  let descriptor;
  try {
    descriptor = openSync(path, "r");
    const size = fstatSync(descriptor).size;
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    readSync(descriptor, buffer, 0, length, size - length);
    const text = buffer.toString("utf8");
    // A read that began mid-file starts on a partial line.
    return size > length ? text.slice(text.indexOf("\n") + 1) : text;
  } catch (error) {
    return error.code === "ENOENT" ? "" : `(unreadable: ${error.code})`;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/** A crash loop writes the same stack hundreds of times; keep one copy and a
 * count, whether the repeat is a single line or a whole block. */
export function collapseRepeats(lines) {
  const out = [];
  for (let i = 0; i < lines.length;) {
    let collapsed = false;
    for (let span = 1; span <= 24 && i + 2 * span <= lines.length; span++) {
      const same = (at) =>
        lines.slice(at, at + span).every((line, k) => line === lines[i + k]);
      if (!same(i + span)) continue;
      let times = 2;
      while (i + (times + 1) * span <= lines.length && same(i + times * span))
        times++;
      out.push(...lines.slice(i, i + span));
      out.push(
        `… the previous ${span === 1 ? "line" : `${span} lines`} repeated ${times - 1} more time${times === 2 ? "" : "s"}`,
      );
      i += times * span;
      collapsed = true;
      break;
    }
    if (!collapsed) out.push(lines[i++]);
  }
  return out;
}

const fence = (text) =>
  // A log line can itself hold a code fence; a longer fence always closes it.
  `\`\`\`\`text\n${text.replace(/`{4,}/g, "```")}\n\`\`\`\``;

function logSection(title, path, limits) {
  const lines = collapseRepeats(
    tail(path, limits.logTail)
      .split("\n")
      .filter((line) => line.trim()),
  ).slice(-limits.logLines);
  return `## ${title}\n\n${lines.length ? fence(lines.join("\n")) : "_Empty or missing._"}`;
}

/** AI calls as counts, timings and outcomes: the usage log never holds a
 * prompt, a reply or validator text, so none can reach a report this way. */
function usageSection(path, limits) {
  const rows = [];
  for (const line of tail(path, 400_000).split("\n")) {
    if (!line.trim()) continue;
    try {
      // A bare `null` or number is valid JSON but not a usage row; reading a
      // field of `null` would fail the whole report.
      const row = JSON.parse(line);
      if (isRecord(row)) rows.push(row);
    } catch {}
  }
  const recent = rows.slice(-limits.usageRows);
  if (!recent.length) return "## Recent AI calls\n\n_None recorded._";
  const cell = (value) =>
    value === null || value === undefined
      ? ""
      : String(value).replace(/[|\n]/g, " ");
  const seconds = (ms) => (Number.isFinite(ms) ? (ms / 1000).toFixed(1) : "");
  const table = recent.map(
    (row) =>
      `| ${[
        row.at,
        row.operation,
        row.phase,
        row.conversationTurn,
        row.attempt,
        `${row.alias ?? ""}/${row.effort ?? ""}`,
        row.model,
        row.outcome,
        seconds(row.durationMs),
        row.outputTokens,
        Number.isFinite(row.costUsd) ? row.costUsd.toFixed(3) : "",
      ]
        .map(cell)
        .join(" | ")} |`,
  );
  const failed = recent.filter((row) => row.outcome !== "accepted").length;
  return [
    "## Recent AI calls",
    "",
    `Newest ${recent.length} of the usage log; ${failed} did not end accepted. Times are UTC.`,
    "",
    "| at | operation | phase | turn | attempt | alias/effort | model | outcome | seconds | output tokens | cost USD |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...table,
  ].join("\n");
}

function prune(directory, limits, keep, now) {
  let removed = 0;
  try {
    const reports = readdirSync(directory)
      .filter((name) => REPORT_FILE.test(name))
      .map((name) => {
        const path = join(directory, name);
        try {
          const stat = statSync(path);
          return stat.isFile() ? { path, at: stat.mtimeMs } : null;
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => a.at - b.at);
    const fresh = reports.filter((r) => now - r.at <= limits.maxAgeMs);
    const doomed = [
      ...reports.filter((r) => now - r.at > limits.maxAgeMs),
      ...fresh
        .filter((r) => r.path !== keep)
        .slice(0, Math.max(0, fresh.length - limits.retention)),
    ];
    for (const { path } of doomed) {
      try {
        unlinkSync(path);
        removed++;
      } catch {}
    }
  } catch {}
  return removed;
}

/**
 * @param {{directory: string, logs?: {title: string, path: string}[],
 *   usageLog?: string, status?: () => Promise<string> | string,
 *   now?: () => number, limits?: Partial<typeof REPORT_LIMITS>}} options
 */
export function createBugReports({
  directory,
  logs = [],
  usageLog,
  status,
  now = Date.now,
  limits: overrides = {},
}) {
  const limits = { ...REPORT_LIMITS, ...overrides };
  async function render(description, client) {
    const at = new Date(now()).toISOString();
    let connection = "unknown";
    try {
      connection = String((await status?.()) ?? "unknown");
    } catch (error) {
      connection = `status check failed: ${error.message}`;
    }
    return [
      "# Learning workspace bug report",
      "",
      `- Generated: ${at}`,
      `- Claude connection: ${connection}`,
      `- Bridge process: pid ${process.pid}, Node ${process.version}, up ${Math.round(process.uptime())} s`,
      "",
      "## What went wrong",
      "",
      description.trim() || "_No description given._",
      "",
      client.trim() || "_The browser sent no diagnostics._",
      "",
      ...(usageLog ? [usageSection(usageLog, limits), ""] : []),
      ...logs.flatMap(({ title, path }) => [
        logSection(title, path, limits),
        "",
      ]),
    ].join("\n");
  }
  function save(markdown) {
    privateDirectory(directory);
    const stamp = new Date(now()).toISOString().replace(/[:.]/g, "-");
    // Exclusive create: two reports in one millisecond never share a file.
    for (let n = 0; ; n++) {
      const path = join(directory, `bug-report-${stamp}${n ? `-${n}` : ""}.md`);
      try {
        writeFileSync(path, markdown, { flag: "wx", mode: 0o600 });
        return path;
      } catch (error) {
        if (error.code !== "EEXIST" || n > 50) throw error;
      }
    }
  }
  return {
    directory,
    async route(req, res) {
      if (req.url !== "/api/bug-report") return false;
      if (req.method !== "POST") {
        res.writeHead(405, { Allow: "POST" });
        res.end(JSON.stringify({ error: "Method not allowed" }));
        return true;
      }
      // A JSON body cannot be sent by a plain cross-site form.
      if (!/^application\/json\b/i.test(req.headers["content-type"] ?? ""))
        throw new HttpInputError(415, "Send the report as JSON");
      const body = await readJsonBody(req, limits.client + 200_000);
      if (
        !isRecord(body) ||
        !["save", "render"].includes(body.mode) ||
        typeof body.description !== "string" ||
        typeof body.client !== "string"
      )
        throw new HttpInputError(400, "Invalid bug report");
      if (body.description.length > limits.description)
        throw new HttpInputError(413, "The description is too long");
      if (body.client.length > limits.client)
        throw new HttpInputError(413, "The diagnostics are too large");
      const markdown = await render(body.description, body.client);
      if (body.mode === "render") {
        res.end(JSON.stringify({ markdown }));
        return true;
      }
      const savedPath = save(markdown);
      const removed = prune(directory, limits, savedPath, now());
      const described = body.description.trim();
      res.end(
        JSON.stringify({
          delivery: "file-pointer",
          savedPath,
          bytes: Buffer.byteLength(markdown),
          removed,
          clipboardText: [
            "Bug report for the learning workspace.",
            `The full report (diagnostics and logs) is saved at: ${savedPath}`,
            "Read that file from disk; it is not pasted here.",
            ...(described ? ["", "What went wrong:", described] : []),
          ].join("\n"),
        }),
      );
      return true;
    },
  };
}
