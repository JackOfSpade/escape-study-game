/** Learner-filed bug reports. The browser contributes what only it knows (the
 * screen, the open question, its run diagnostics); the study bridge adds this
 * computer's service logs and writes one Markdown file. "Copy to clipboard"
 * copies that file's path and the learner's own words, never the report body. */

interface BugReportQuestion {
  title: string;
  /** The scheduling and provenance line the workspace no longer displays. */
  provenance: string;
  state: string;
  error?: string;
  generation?: string;
  part?: string;
  prompt?: string;
  messages: { kind: string; author: string; text: string }[];
  requests: { state: string; error?: string }[];
  draft?: string;
}
interface BugReportSnapshot {
  url: string;
  build?: string;
  userAgent: string;
  viewport: string;
  view: string;
  terminalOpen: boolean;
  connection: string;
  saveError?: string;
  /** Short status lines currently on screen, by name. */
  status: Record<string, string>;
  question?: BugReportQuestion;
  /** RunLogs.export(): the newest three runs' bounded diagnostics. */
  logs: string;
}

/** Characters of browser diagnostics kept; the newest entries win. */
const CLIENT_REPORT_LIMIT = 600_000;
const DRAFT_KEY = "bug-report-draft";

const fence = (text: string, language = "text") =>
  `\`\`\`\`${language}\n${text.replace(/`{4,}/g, "```")}\n\`\`\`\``;
const list = (rows: [string, string | undefined][]) =>
  rows
    .filter((row): row is [string, string] => !!row[1])
    .map(([name, value]) => `- ${name}: ${value.replace(/\s+/g, " ")}`)
    .join("\n");

/** One run as compact lines: its audit events in full, then its newest
 * detail entries. Unreadable diagnostics are reported, never thrown. */
function diagnostics(logs: string, budget: number) {
  let runs: unknown;
  try {
    runs = (JSON.parse(logs) as { runs?: unknown }).runs;
  } catch {
    return "_The run diagnostics could not be read._";
  }
  if (!Array.isArray(runs) || !runs.length) return "_No runs recorded._";
  const sections: string[] = [];
  // Newest run first: it is the one a report is almost always about.
  for (const run of [...runs].reverse()) {
    const {
      entries = [],
      audit,
      ...head
    } = run as {
      entries?: unknown[];
      audit?: { events?: unknown[] } & Record<string, unknown>;
    } & Record<string, unknown>;
    const { events = [], ...summary } = audit ?? {};
    const lines = (items: unknown[]) =>
      items.map((item) => JSON.stringify(item));
    let detail = lines(entries);
    const fixed =
      JSON.stringify({ ...head, audit: summary }).length +
      lines(events).join("\n").length;
    // Drop the oldest detail entries until this run fits what is left.
    let size = detail.reduce((sum, line) => sum + line.length + 1, 0);
    let dropped = 0;
    while (detail.length && fixed + size > budget) {
      size -= detail[0].length + 1;
      detail = detail.slice(1);
      dropped++;
    }
    if (fixed > budget && sections.length) break;
    budget -= fixed + size;
    sections.push(
      [
        `### Run ${String(head.id ?? "").slice(0, 12)} started ${String(head.started ?? "unknown")}`,
        "",
        fence(JSON.stringify({ ...head, audit: summary }, null, 1), "json"),
        "",
        `Lifecycle events (${events.length}):`,
        "",
        fence(lines(events).join("\n") || "(none)", "json"),
        "",
        `Detail entries (${detail.length}${dropped ? `, ${dropped} older omitted for size` : ""}):`,
        "",
        fence(detail.join("\n") || "(none)", "json"),
      ].join("\n"),
    );
    if (budget <= 0) break;
  }
  return sections.join("\n\n");
}

/** The browser's part of a report, as Markdown. Pure: tests call it directly. */
export function buildClientReport(
  snapshot: BugReportSnapshot,
  includeQuestion: boolean,
  limit = CLIENT_REPORT_LIMIT,
) {
  const q = snapshot.question;
  const parts = [
    "## Browser",
    "",
    list([
      ["Page", snapshot.url],
      ["Build", snapshot.build],
      ["Browser", snapshot.userAgent],
      ["Viewport", snapshot.viewport],
      [
        "View",
        `${snapshot.view}${snapshot.terminalOpen ? ", question open" : ""}`,
      ],
      ["Claude connection", snapshot.connection],
      ["Save error", snapshot.saveError],
      ...Object.entries(snapshot.status).map(
        ([name, value]) => [`Status · ${name}`, value] as [string, string],
      ),
    ]),
    "",
    "## Current question",
    "",
  ];
  if (!q) parts.push("_No question is selected._");
  else {
    const counts = q.messages.reduce<Record<string, number>>(
      (sum, m) => ((sum[m.kind] = (sum[m.kind] ?? 0) + 1), sum),
      {},
    );
    parts.push(
      list([
        ["State", q.state],
        ["Part", q.part],
        ["Generation", q.generation],
        ["Error", q.error],
        ["Scheduling and provenance (hidden from the learner)", q.provenance],
        [
          "Messages",
          Object.entries(counts)
            .map(([kind, n]) => `${n} ${kind}`)
            .join(", ") || "none",
        ],
        [
          "Tutor requests",
          q.requests
            .map((r) => `${r.state}${r.error ? ` (${r.error})` : ""}`)
            .join(", ") || "none",
        ],
        ...(includeQuestion
          ? []
          : ([
              [
                "Question text and conversation",
                "left out at the learner's request",
              ],
            ] as [string, string][])),
      ]),
    );
    if (includeQuestion)
      parts.push(
        "",
        `### ${q.title || "Untitled"}`,
        "",
        fence(q.prompt ?? "(no question text yet)"),
        "",
        "### Conversation",
        "",
        q.messages.length
          ? q.messages
              .map((m) => `**${m.author} (${m.kind})**\n\n${fence(m.text)}`)
              .join("\n\n")
          : "_Empty._",
        ...(q.draft ? ["", "### Unsent draft", "", fence(q.draft)] : []),
      );
  }
  const head = parts.join("\n");
  return `${head}\n\n## Browser diagnostics\n\n${diagnostics(snapshot.logs, Math.max(20_000, limit - head.length))}`;
}

type Mode = "clipboard" | "file";
interface Wiring {
  collect: () => BugReportSnapshot | Promise<BugReportSnapshot>;
  /** Called with a short record of each attempt, for the run diagnostics. */
  log?: (type: string, data: Record<string, unknown>) => void;
}

async function send(
  mode: "save" | "render",
  description: string,
  client: string,
) {
  const response = await fetch("/api/bug-report", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode, description, client }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!response.ok || !body)
    throw Error(
      typeof body?.error === "string"
        ? body.error
        : `The study bridge answered ${response.status}`,
    );
  return body;
}

function download(markdown: string) {
  const url = URL.createObjectURL(
    new Blob([markdown], { type: "text/markdown" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = `bug-report-${new Date().toISOString().replace(/[:.]/g, "-")}.md`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Wire the toolbar button and its dialog, both already in the page. */
export function mountBugReport({ collect, log }: Wiring) {
  const dialog = document.querySelector<HTMLDialogElement>("#bug-report")!;
  const find = <T extends HTMLElement>(selector: string) =>
    dialog.querySelector<T>(selector)!;
  const text = find<HTMLTextAreaElement>("#bug-report-description");
  const include = find<HTMLInputElement>("#bug-report-include");
  const status = find<HTMLElement>("#bug-report-status");
  const buttons = [...dialog.querySelectorAll<HTMLButtonElement>("button")];
  let busy = false;
  // The description survives closing the dialog, but not the browser session.
  try {
    text.value = sessionStorage.getItem(DRAFT_KEY) ?? "";
  } catch {}
  text.addEventListener("input", () => {
    try {
      sessionStorage.setItem(DRAFT_KEY, text.value);
    } catch {}
  });
  const say = (message: string, kind: "" | "ok" | "error" = "") => {
    status.textContent = message;
    status.dataset.kind = kind;
  };
  async function submit(mode: Mode) {
    if (busy) return;
    busy = true;
    for (const button of buttons) button.disabled = true;
    say(mode === "clipboard" ? "Saving the report…" : "Building the report…");
    const description = text.value.trim();
    let client = "";
    let outcome = "failed";
    try {
      client = buildClientReport(await collect(), include.checked);
      if (mode === "clipboard") {
        const saved = await send("save", description, client);
        const path = String(saved.savedPath);
        try {
          await navigator.clipboard.writeText(String(saved.clipboardText));
          say(
            `Saved to ${path}. Its path, not the report itself, is on your clipboard.`,
            "ok",
          );
          outcome = "saved-and-copied";
        } catch {
          say(
            `Saved to ${path}. The clipboard could not be written; open that file directly.`,
            "ok",
          );
          outcome = "saved-clipboard-failed";
        }
      } else {
        download(String((await send("render", description, client)).markdown));
        say("The report was downloaded.", "ok");
        outcome = "downloaded";
      }
      text.value = "";
      try {
        sessionStorage.removeItem(DRAFT_KEY);
      } catch {}
    } catch (error) {
      // The bridge is the usual thing being reported as broken, so the
      // browser's own half must still reach the learner without it.
      const reason = error instanceof Error ? error.message : String(error);
      const fallback = `# Learning workspace bug report (browser only)\n\nThe study bridge could not add its logs: ${reason}\n\n## What went wrong\n\n${description || "_No description given._"}\n\n${client}`;
      try {
        if (!client) throw error;
        if (mode === "file") {
          download(fallback);
          say(
            `The study bridge did not answer (${reason}), so the downloaded report has the browser's diagnostics only.`,
            "error",
          );
        } else {
          const copied = await navigator.clipboard
            .writeText(fallback)
            .then(() => true)
            .catch(() => false);
          if (!copied) download(fallback);
          say(
            `The report file could not be saved (${reason}), so the browser's diagnostics were ${copied ? "copied to the clipboard" : "downloaded"} instead.`,
            "error",
          );
        }
        outcome = "browser-only";
      } catch {
        say(`The report could not be created: ${reason}`, "error");
      }
    } finally {
      busy = false;
      for (const button of buttons) button.disabled = false;
      log?.("bug-report", { mode, outcome, described: !!description });
    }
  }
  find<HTMLButtonElement>("#bug-report-copy").onclick = () =>
    void submit("clipboard");
  find<HTMLButtonElement>("#bug-report-save").onclick = () =>
    void submit("file");
  find<HTMLButtonElement>("#bug-report-close").onclick = () => dialog.close();
  // A click on the backdrop closes it, as the other dialogs do with Esc.
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog && !busy) dialog.close();
  });
  const open = () => {
    say("");
    if (!dialog.open) dialog.showModal();
    text.focus();
  };
  for (const button of document.querySelectorAll<HTMLButtonElement>(
    "[data-bug-report]",
  ))
    button.onclick = open;
  return { open };
}
