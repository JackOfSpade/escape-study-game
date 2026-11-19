import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Direct .mjs test.
import { questionMetrics, summarize } from "../scripts/ai-capture/question-metrics.mjs"; // prettier-ignore

const fence = "```";

test("fenced code is excluded from word counts", () => {
  const m = questionMetrics({
    title: "t",
    prompt: `Read this code.\n${fence}js\nconst a = 1;\nconst b = 2;\n${fence}\nName the bug.`,
  });
  assert.equal(m.sharedWords, 6);
  assert.equal(m.codeLines, 2);
});

test("bullets are counted outside code only", () => {
  const m = questionMetrics({
    title: "t",
    prompt: `Facts:\n- one\n* two\n1. three\n${fence}\n- not a bullet\n${fence}`,
  });
  assert.equal(m.bulletLines, 3);
});

test("sharedShare divides shared words by shared plus part words", () => {
  const m = questionMetrics({
    title: "t",
    prompt: "one two three",
    parts: ["a b c", "d"],
  });
  assert.deepEqual(m.partWords, [3, 1]);
  assert.equal(m.partCount, 2);
  assert.equal(m.sharedShare, 3 / 7);
  assert.equal(questionMetrics({ title: "", prompt: "" }).sharedShare, 0);
});

test("perItemJustification needs a per-item phrase near a reason word", () => {
  const yes = questionMetrics({
    title: "t",
    prompt: "Setup.",
    parts: ["For each one, say why that would hurt."],
  });
  const no = questionMetrics({
    title: "t",
    prompt: "For each input, give the output.",
  });
  assert.equal(yes.perItemJustification, true);
  assert.equal(no.perItemJustification, false);
});

test("a problem with no parts", () => {
  const m = questionMetrics({
    title: "t",
    prompt: "Why is the sky blue?",
    rubric: ["scattering", "wavelength"],
    scopeDefinitions: [{ facets: ["a", "b"] }, { facets: ["c"] }],
    estimatedSolveSeconds: 90,
  });
  assert.equal(m.partCount, 0);
  assert.deepEqual(m.partWords, []);
  assert.equal(m.sharedShare, 1);
  assert.equal(m.rubricLines, 2);
  assert.equal(m.rubricLineWordsMax, 1);
  assert.equal(
    questionMetrics({ prompt: "x", rubric: ["one two", "a b c d\ne"] })
      .rubricLineWordsMax,
    4,
  );
  assert.equal(m.facetCount, 3);
  assert.equal(m.estimatedSolveSeconds, 90);
  assert.equal(questionMetrics({ title: "t", prompt: "x" }).estimatedSolveSeconds, null); // prettier-ignore
});

test("summarize reports median, p90, max and the justification share", () => {
  const rows = [10, 20, 30].map((n, i) =>
    questionMetrics({
      title: "t",
      prompt: "w ".repeat(n),
      parts: i === 0 ? ["Explain why for each one."] : undefined,
    }),
  );
  const s = summarize(rows);
  assert.equal(s.count, 3);
  assert.deepEqual(s.sharedWords, { median: 20, p90: 30, max: 30 });
  assert.equal(s.perItemJustificationShare, 1 / 3);
});

test("the question that prompted the reading and repetition rules is flagged", () => {
  // The generated question, as issued on 2026-11-19 before the rules changed.
  const facts = [
    "Product: a consumer, browser-based photo editor.",
    'Problem: exporting large images often failed. For images over 20 megapixels, the server-side export request regularly hit a 30-second timeout. The user then saw a generic "Export failed" message and had to start the export again. Support tickets about failed exports were the main complaint the team was asked to fix.',
    "Team: Alex (frontend engineer), Mei (backend engineer), Jordan (engineering manager), and Lena (designer).",
    "Mei proposed moving export rendering into a background job with a status endpoint. Jordan approved it, and Mei built it.",
    'Alex built the export progress indicator, which checks the status endpoint, and the "Your export is ready" download notification.',
    'Alex proposed keeping the editor usable while an export runs, instead of blocking the screen with a modal until the export finishes. Lena and Jordan agreed. The downside was that a user could keep editing after starting an export, so the downloaded file might not match what was on screen. To address that, Alex labeled each export with the time it was started (for example, "Version from 2:14 PM").',
    "Alex's first version of the progress indicator checked status every second. Mei pointed out that this put unnecessary load on the status endpoint, so Alex changed it to every 3 seconds. Alex now agrees the checking frequency with the backend engineer before building the UI.",
    "Measurement: export logs show that, for images over 20 megapixels, failed exports divided by started exports was about 18% in the 2 weeks before launch and about 3% in the 2 weeks after launch.",
    "In the same 2-week window after launch, the infrastructure team also upgraded the render servers to machines with more memory.",
    "No one measured user satisfaction, paid conversions, or revenue for this change.",
  ];
  const m = questionMetrics({
    title: "Photo editor export project story",
    prompt:
      "A friend, Alex, is preparing for a product-engineering interview. Below are the real facts of one of Alex's past projects and the answer Alex has drafted for \"Tell me about a project you're proud of.\" Treat the facts as true and complete: Alex has no other data or measurements.\n\nReal facts about the project\n\n" +
      facts.map((fact) => `* ${fact}`).join("\n") +
      '\n\nAlex\'s draft answer\n"Our users were frustrated that the editor was slow, so I led a project to rebuild our export system. I designed the new asynchronous export architecture with a job queue and built the whole pipeline end to end. As a result, export failures dropped by 90%, user satisfaction went up, and it boosted paid conversions. It was a huge success and the team loved it."',
    parts: [
      "Compare Alex's draft with the real facts. Identify each place where the draft misstates the problem, misattributes who did what, or makes a number or outcome claim the facts do not support. For each one, say what an interviewer's follow-up question would likely expose and why that would hurt Alex.",
      "Second ask.",
      "Third ask.",
    ],
  });
  assert.equal(m.perItemJustification, true);
  assert.equal(m.bulletLines, 10);
  // Far past the "about six short lines" the shape rules ask for.
  assert.ok(m.sharedWords > 300, String(m.sharedWords));
  assert.ok(m.sharedShare > 0.8, String(m.sharedShare));
});
