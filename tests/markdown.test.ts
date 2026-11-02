import assert from "node:assert/strict";
import test from "node:test";
import { markdownToHtml } from "../src/markdown";

test("a fenced block with a language becomes pre > code without backticks", () => {
  assert.equal(
    markdownToHtml("Try:\n```python\nprint(1)\n```\nDone"),
    "<p>Try:</p><pre><code>print(1)</code></pre><p>Done</p>",
  );
});

test("a fenced block without a language renders the same way", () => {
  assert.equal(
    markdownToHtml("```\nSELECT 1;\nSELECT 2;\n```"),
    "<pre><code>SELECT 1;\nSELECT 2;</code></pre>",
  );
});

test("an unterminated fence renders the rest as code", () => {
  assert.equal(
    markdownToHtml("Intro\n```python\nx = 1\n\ny = 2"),
    "<p>Intro</p><pre><code>x = 1\n\ny = 2</code></pre>",
  );
});

test("script tags are escaped and never become elements", () => {
  const html = markdownToHtml("<script>alert(1)</script>");
  assert.equal(html, "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>");
  assert.ok(!html.includes("<script"));
});

test("ampersands are escaped inside and outside code", () => {
  assert.equal(
    markdownToHtml("a & b `c && d`\n```\ne & f <g>\n```"),
    "<p>a &amp; b <code>c &amp;&amp; d</code></p><pre><code>e &amp; f &lt;g&gt;</code></pre>",
  );
});

test("an img with onerror stays text", () => {
  const html = markdownToHtml('hi <img src=x onerror="alert(1)">');
  assert.equal(
    html,
    "<p>hi &lt;img src=x onerror=&quot;alert(1)&quot;&gt;</p>",
  );
  assert.ok(!html.includes("<img"));
});

test("inline code keeps markdown syntax literal", () => {
  assert.equal(
    markdownToHtml("use `a **b** c` here"),
    "<p>use <code>a **b** c</code> here</p>",
  );
  assert.equal(
    markdownToHtml("```\n**not bold** _x_ # nope\n```"),
    "<pre><code>**not bold** _x_ # nope</code></pre>",
  );
});

test("bold and italic render, and snake_case is left alone", () => {
  assert.equal(
    markdownToHtml("**bold** *it* _em_ snake_case_name"),
    "<p><strong>bold</strong> <em>it</em> <em>em</em> snake_case_name</p>",
  );
});

test("nested-looking emphasis never yields misnested tags", () => {
  // Emphasis around bold is not interpreted; the stars stay literal.
  const html = markdownToHtml("**a _b** c_ and *x **y** z*");
  assert.equal(
    html,
    "<p><strong>a _b</strong> c_ and *x <strong>y</strong> z*</p>",
  );
  for (const input of ["**a *b** c*", "*a **b* c**", "***x***", "** a **"]) {
    const out = markdownToHtml(input);
    const stack: string[] = [];
    for (const [, close, name] of out.matchAll(/<(\/?)(\w+)>/g)) {
      if (name === "p") continue;
      if (!close) stack.push(name);
      else assert.equal(stack.pop(), name, `${input} -> ${out}`);
    }
    assert.deepEqual(stack, [], `${input} -> ${out}`);
  }
});

test("headings, bullet and numbered lists, paragraphs and line breaks", () => {
  assert.equal(
    markdownToHtml("# One\n### Three\n- a\n* b\n1. c\n2) d\n\nline1\nline2"),
    "<h4>One</h4><h4>Three</h4><ul><li>a</li><li>b</li></ul><ol><li>c</li><li>d</li></ol><p>line1<br>line2</p>",
  );
});

test("links, images and raw urls stay plain text", () => {
  const html = markdownToHtml(
    "[click](https://evil.example) ![x](https://evil.example/i.png) https://evil.example <https://evil.example>",
  );
  assert.ok(!html.includes("<a"));
  assert.ok(!html.includes("<img"));
  assert.ok(html.includes("[click](https://evil.example)"));
  assert.ok(html.includes("![x](https://evil.example/i.png)"));
  assert.ok(html.includes("&lt;https://evil.example&gt;"));
});
