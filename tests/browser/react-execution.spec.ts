import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import type { Server } from "node:http";
// @ts-expect-error Isolated local execution server, no provider configured.
import { createStudyBridgeServer } from "../../scripts/study-bridge-server.mjs";
import { openApp } from "./helpers/agent-menu";
import { isolateRunnerBridge } from "./helpers/runner-bridge";
import { flushStudySave } from "./study-harness";

test("container workspace React API: immutable checks and preview survive later edits and reload without academic credit", async ({
  page,
}) => {
  test.skip(
    process.env.RUN_CONTAINER_BROWSER !== "1",
    "Requires the already-installed isolated Docker React runtime",
  );
  test.setTimeout(45000);
  const server: Server = createStudyBridgeServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw Error("No isolated execute server");
  await isolateRunnerBridge(page, `http://127.0.0.1:${address.port}`);
  try {
    await openApp(page);
    await page.evaluate(async () => {
      const d = (window as any).__studyApp,
        g = d.record,
        r = d.roadmap,
        root = "/src/";
      const { initialStudy, eligible } = await import(
          /* @vite-ignore */ root + "curriculum.ts"
        ),
        { initialLearner, reconcileGates } = await import(
          /* @vite-ignore */ root + "learner.ts"
        ),
        { question } = await import(
          /* @vite-ignore */ "/tests/helpers/" + "record.ts"
        );
      const l = initialLearner(r, "test");
      for (const o of r.tracks.PE.objectives) l.cells[o.id].states[0] = "P";
      l.reviews = {};
      l.cycleOffset = 1;
      reconcileGates(r, l);
      g.study = initialStudy(r, "live");
      g.study.learner = l;
      const contract = eligible(r, g.study);
      if (contract.track !== "PE" || contract.depth !== 2)
        throw Error("Requires synthetic PE D2");
      const e = (g.encounters["question-0"] = question(g, "question-0"));
      e.problem = {
        title: "Synthetic React task / real browser execution",
        prompt: "Runtime API integration fixture only",
        starter: "",
        rubric: [],
        provenance: "study-mode",
        contract,
        runtime: {
          language: "typescript",
          environment: "react",
          steps: [
            { kind: "click", selector: "button" },
            { kind: "expect-text", selector: "button", text: "Count 1" },
          ],
        },
      };
    });
    const code =
      "import {useState} from 'react';export default function App(){const[n,setN]=useState(0);return <button onClick={()=>setN(n+1)}>Count {n}</button>}";
    const before = await page.evaluate(async (code) => {
      const d = (window as any).__studyApp,
        g = d.record,
        e = g.encounters["question-0"],
        root = "/src/";
      const { edit } = await import(/* @vite-ignore */ root + "ai.ts"),
        { runWorkspace } = await import(
          /* @vite-ignore */ root + "execution.ts"
        );
      edit(g, e, code, e.revision, d.roadmap);
      void runWorkspace(g, e, d.roadmap);
      return { status: e.executions[0].status };
    }, code);
    expect(before.status).toBe("pending");
    const draft = "export default ()=> <p>later draft</p>";
    await page.evaluate(async (draft) => {
      const d = (window as any).__studyApp,
        e = d.record.encounters["question-0"],
        root = "/src/",
        { edit } = await import(/* @vite-ignore */ root + "ai.ts");
      edit(d.record, e, draft, e.revision, d.roadmap);
    }, draft);
    await expect(page.locator("#terminal")).toBeHidden();
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              (window as any).__studyApp.record.encounters["question-0"]
                .executions[0].status,
          ),
        { timeout: 30000 },
      )
      .toBe("finished");
    const result = await page.evaluate(async () => {
      const g = (window as any).__studyApp.record,
        e = g.encounters["question-0"],
        job = e.executions[0],
        root = "/src/",
        { executionText } = await import(
          /* @vite-ignore */ root + "execution-presentation.ts"
        ),
        { executionEvidence } = await import(
          /* @vite-ignore */ root + "execution.ts"
        );
      // Browser decoding of the actual checked data URL is diagnostic only;
      // the study workspace intentionally has no embedded editor/preview.
      const image = new Image();
      image.src = job.preview.dataUrl;
      await image.decode();
      return {
        job,
        evidence: g.study.learner.evidence.length,
        state: e.state,
        history: e.history.filter((h: any) => h.kind === "execution"),
        text: executionText(job),
        packet: executionEvidence(job),
        image: { width: image.naturalWidth, height: image.naturalHeight },
        draft: e.workspace,
      };
    });
    expect(result.job.code).toBe(code);
    expect(
      result.job.receipt.executed,
      JSON.stringify(result.job.receipt),
    ).toBe(true);
    expect(
      result.job.receipt.exitCode,
      JSON.stringify(result.job.receipt),
    ).toBe(0);
    expect(JSON.parse(result.job.receipt.stdout).domText).toBe("Count 1");
    expect(result.evidence).toBe(0);
    expect(result.state).toBe("available");
    expect(result.draft).toBe(draft);
    expect(result.image).toEqual({ width: 640, height: 400 });
    expect(JSON.stringify(result.history)).not.toContain("base64");
    expect(JSON.stringify(result.packet)).not.toContain("base64");
    expect(result.text).toContain("1 of 1 attempted task checks matched");
    expect(result.text).toContain("Visible text:\nCount 1");
    expect(result.text).toContain(
      "independent understanding remain unassessed",
    );
    const receiptPath = test.info().outputPath("captured-react-receipt.json");
    await writeFile(receiptPath, JSON.stringify(result.job.receipt, null, 2));
    await test.info().attach("captured-react-receipt", {
      path: receiptPath,
      contentType: "application/json",
    });
    const previewPath = test.info().outputPath("captured-react-preview.jpg");
    await writeFile(
      previewPath,
      Buffer.from(result.job.preview.dataUrl.split(",")[1], "base64"),
    );
    await test.info().attach("actual-captured-react-preview", {
      path: previewPath,
      contentType: "image/jpeg",
    });
    await flushStudySave(page);
    await page.reload();
    await page.waitForFunction(() => !!(window as any).__studyApp);
    const saved = await page.evaluate(() => {
      const e = (window as any).__studyApp.record.encounters["question-0"];
      return { job: e.executions[0], draft: e.workspace };
    });
    expect(saved.job).toEqual(result.job);
    expect(saved.draft).toBe(draft);
    await expect(page.locator("#terminal")).toBeHidden();
    // A forged HTTP preview in a new response is rejected by the real runtime
    // validator before it can enter the saved job or cause an image request.
    let leaked = false;
    await page.route("https://example.invalid/**", (route) => {
      leaked = true;
      return route.abort();
    });
    await page.route("**/api/execute", (route) =>
      route.fulfill({
        json: {
          ...result.job.receipt,
          preview: {
            ...result.job.preview,
            dataUrl: "https://example.invalid/forged-preview",
          },
        },
      }),
    );
    await page.evaluate(async (code) => {
      const d = (window as any).__studyApp,
        e = d.record.encounters["question-0"],
        root = "/src/",
        { edit } = await import(/* @vite-ignore */ root + "ai.ts"),
        { runWorkspace } = await import(
          /* @vite-ignore */ root + "execution.ts"
        );
      edit(d.record, e, code, e.revision, d.roadmap);
      await runWorkspace(d.record, e, d.roadmap);
    }, code);
    const rejected = await page.evaluate(
      () =>
        (window as any).__studyApp.record.encounters["question-0"]
          .executions[1],
    );
    expect(rejected.status).toBe("error");
    expect(rejected.error).toContain("Invalid browser preview");
    expect(rejected.preview).toBeUndefined();
    expect(leaked).toBe(false);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
