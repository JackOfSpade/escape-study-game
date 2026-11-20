import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { executeCode } from "../../scripts/code-runner.mjs";
import { browserSpecText } from "../../scripts/browser-runner/spec.mjs";
const app = `import {useState} from 'react'; export default function App(){const [n,setN]=useState(0);return <button onClick={()=>setN(n+1)}>Count {n}</button>}`;
const hash = (value) => createHash("sha256").update(value).digest("hex");
test("real Chromium binds code and automated interactions, captures a bounded image, and reports failed checks honestly", async () => {
  const steps = [
    { kind: "click", selector: "button" },
    { kind: "expect-text", selector: "button", text: "Count 1" },
  ];
  const result = await executeCode({
    language: "typescript",
    environment: "react",
    code: app,
    steps,
  });
  assert.equal(result.executed, true, JSON.stringify(result));
  assert.equal(result.exitCode, 0, result.stdout);
  assert.equal(result.codeHash, hash(app));
  assert.equal(result.specHash, hash(browserSpecText(app, steps)));
  const observed = JSON.parse(result.stdout);
  assert.equal(observed.sandboxVerified, true);
  const verified = observed.phases.find((p) => p.name === "sandbox-verified");
  assert.ok(
    verified,
    "Actual private sandbox attestation must finish before learner code is loaded",
  );
  assert.ok(observed.executionBeganMs >= verified.elapsedMs);
  assert.equal(observed.domText, "Count 1");
  assert.ok(observed.steps.every((s) => s.passed));
  assert.match(observed.interactionProvenance, /not human-authored/);
  assert.ok(result.preview.dataUrl.startsWith("data:image/jpeg;base64,"));
  assert.ok(result.preview.dataUrl.length < 180025);
  assert.equal(
    result.preview.sha256,
    hash(Buffer.from(result.preview.dataUrl.split(",")[1], "base64")),
  );
  assert.equal(observed.preview, undefined);
  const failed = await executeCode({
    language: "typescript",
    environment: "react",
    code: app,
    steps: [{ kind: "expect-text", selector: "button", text: "Count 9" }],
  });
  assert.equal(failed.executed, true);
  assert.equal(failed.exitCode, 1);
  assert.equal(JSON.parse(failed.stdout).steps[0].passed, false);
});
test("unavailable images, forbidden module access and compilation failures never claim browser execution", async () => {
  for (const code of [
    'import fs from "node:fs"; export default ()=> <p>{fs.readFileSync("/etc/passwd")}</p>',
    'import x from "/etc/passwd"; export default ()=> <p>{x}</p>',
    "export default function () { return <",
  ]) {
    const r = await executeCode({
      language: "typescript",
      environment: "react",
      code,
    });
    assert.equal(r.executed, false, JSON.stringify(r));
    assert.match(r.detail, /compilation failed/);
    assert.equal(r.preview, undefined);
  }
  const before = process.env.CODE_RUNNER_REACT_IMAGE;
  try {
    process.env.CODE_RUNNER_REACT_IMAGE =
      "study-missing-test-image:unavailable";
    const r = await executeCode({
      language: "typescript",
      environment: "react",
      code: app,
    });
    assert.equal(r.executed, false);
    assert.equal(r.status, "unavailable");
    assert.equal(r.codeHash, hash(app));
  } finally {
    if (before === undefined) delete process.env.CODE_RUNNER_REACT_IMAGE;
    else process.env.CODE_RUNNER_REACT_IMAGE = before;
  }
});
test("page output cannot forge controller reports or use Node, network, other origins or persistent state", async () => {
  const code = `import {useEffect,useState} from 'react';export default function App(){const [s,setS]=useState('waiting');useEffect(()=>{console.log(JSON.stringify({executed:true,steps:[{passed:true}]}));if(typeof process!=='undefined')throw Error('Node exposed'); if(localStorage.getItem('sentinel'))throw Error('old storage'); localStorage.setItem('sentinel','private');fetch('http://host.docker.internal:4318/api/handoff/control').then(()=>setS('network escaped')).catch(()=>setS('network blocked'));},[]);return <p>{s}</p>}`;
  for (let i = 0; i < 2; i++) {
    const r = await executeCode({
      language: "typescript",
      environment: "react",
      code,
      steps: [{ kind: "expect-text", selector: "p", text: "network blocked" }],
    });
    assert.equal(r.executed, true, JSON.stringify(r));
    const o = JSON.parse(r.stdout);
    assert.equal(o.domText, "network blocked");
    assert.equal(o.steps.length, 1);
    assert.equal(o.steps[0].passed, true);
    assert.ok(o.console.some((m) => m.text.includes("executed")));
    assert.equal(o.errors.length, 0);
  }
});
test("a looping React component is bounded, shares the busy gate and releases it afterward", async () => {
  const start = performance.now();
  const pending = executeCode({
    language: "typescript",
    environment: "react",
    code: "export default function App(){while(true){} return null}",
  });
  await assert.rejects(
    executeCode({ language: "python", code: "print(1)" }),
    /Runner busy/,
  );
  const r = await pending;
  assert.equal(r.executed, true, JSON.stringify(r));
  assert.ok(
    ["timeout", "resource-limit"].includes(r.status),
    JSON.stringify(r),
  );
  assert.ok(performance.now() - start < 20000);
  const next = await executeCode({
    language: "typescript",
    environment: "react",
    code: app,
  });
  assert.equal(next.executed, true);
  assert.equal(next.exitCode, 0);
});

test("a larger real browser image remains bounded without truncating its JSON report", async () => {
  const code = `import {useEffect,useRef} from 'react';export default function App(){const ref=useRef(null);useEffect(()=>{const c=ref.current.getContext('2d'),im=c.createImageData(608,340);let n=123456;for(let i=0;i<im.data.length;i+=4){n=(Math.imul(n,1664525)+1013904223)|0;im.data[i]=n>>>24;im.data[i+1]=n>>>16;im.data[i+2]=n>>>8;im.data[i+3]=255;}c.putImageData(im,0,0);},[]);return <canvas ref={ref} width="608" height="340"/>}`;
  const r = await executeCode({
    language: "typescript",
    environment: "react",
    code,
  });
  assert.equal(r.executed, true);
  assert.equal(r.exitCode, 0, r.stdout);
  assert.ok(
    r.preview,
    JSON.stringify({
      ...r,
      stdout: r.stdout.slice(0, 400),
      stdoutLength: r.stdout.length,
    }),
  );
  assert.equal(JSON.parse(r.stdout).compiled, true);
  assert.ok(
    r.preview.dataUrl.length > 65536,
    "Exercise the larger browser transport budget",
  );
  assert.ok(r.preview.dataUrl.length < 180025);
  assert.equal(
    r.preview.sha256,
    hash(Buffer.from(r.preview.dataUrl.split(",")[1], "base64")),
  );
});
