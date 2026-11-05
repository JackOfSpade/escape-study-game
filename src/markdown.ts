import { escapeHtml } from "./html";

/**
 * Minimal, dependency-free markdown for untrusted model text. Every piece of
 * text is escaped before a tag is added, so raw HTML never passes through.
 * Links, images and bare URLs are intentionally NOT supported: they remain
 * plain text, so a model reply can never create an anchor.
 */

const OPEN_FENCE = /^\s*```\s*([\w+#.-]*)\s*$/;
const CLOSE_FENCE = /^\s*```\s*$/;
const HEADING = /^\s{0,3}#{1,3}\s+(.*)$/;
const BULLET = /^\s*[-*]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;

// Private-use markers stand in for code spans while emphasis is applied.
const MARK_OPEN = "\uE000";
const MARK_CLOSE = "\uE001";
const MARKERS = /[\uE000\uE001]/g;
const MARKED = /\uE000(\d+)\uE001/g;

const italic = (escaped: string) =>
  escaped
    .replace(/(^|[^\w*])\*(?=\S)([^*]+?)(?<=\S)\*(?![\w*])/g, "$1<em>$2</em>")
    .replace(/(^|[^\w])_(?=\S)([^_]+?)(?<=\S)_(?!\w)/g, "$1<em>$2</em>");

/** Bold wraps italic, never the other way, so tags always nest correctly. */
function emphasis(escaped: string) {
  let out = "",
    last = 0;
  for (const match of escaped.matchAll(/\*\*(?=\S)([^*]+?)(?<=\S)\*\*/g)) {
    out += italic(escaped.slice(last, match.index));
    out += `<strong>${italic(match[1])}</strong>`;
    last = match.index + match[0].length;
  }
  return out + italic(escaped.slice(last));
}

function inline(text: string) {
  const spans: string[] = [];
  const masked = text
    .replace(MARKERS, "")
    .replace(/`([^`\n]+)`/g, (_, code: string) => {
      spans.push(`<code>${escapeHtml(code)}</code>`);
      return `${MARK_OPEN}${spans.length - 1}${MARK_CLOSE}`;
    });
  return emphasis(escapeHtml(masked)).replace(
    MARKED,
    (_, i: string) => spans[Number(i)] ?? "",
  );
}

const startsBlock = (line: string) =>
  OPEN_FENCE.test(line) ||
  HEADING.test(line) ||
  BULLET.test(line) ||
  NUMBERED.test(line);

const indentWidth = (line: string) =>
  /^[ \t]*/.exec(line)![0].replace(/\t/g, "    ").length;

/**
 * Unfenced code still reaches paragraphs (saved and static prompts), where
 * indentation can carry meaning. Each line keeps its indent relative to the
 * paragraph's shallowest line, so an incidental uniform indent still vanishes.
 */
function paragraphLines(lines: string[]) {
  const base = Math.min(...lines.map(indentWidth));
  return lines.map(
    (line) =>
      "&nbsp;".repeat(indentWidth(line) - base) + inline(line.trim()),
  );
}

export function markdownToHtml(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    if (OPEN_FENCE.test(line)) {
      const code: string[] = [];
      i++;
      // An unterminated fence (streaming) takes the rest of the text.
      while (i < lines.length && !CLOSE_FENCE.test(lines[i]))
        code.push(lines[i++]);
      i++;
      out.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      out.push(`<h4>${inline(heading[1].trim())}</h4>`);
      i++;
      continue;
    }
    const list = BULLET.test(line)
      ? BULLET
      : NUMBERED.test(line)
        ? NUMBERED
        : undefined;
    if (list) {
      const items: string[] = [];
      for (let m; i < lines.length && (m = list.exec(lines[i])); i++)
        items.push(`<li>${inline(m[1].trim())}</li>`);
      const tag = list === BULLET ? "ul" : "ol";
      out.push(`<${tag}>${items.join("")}</${tag}>`);
      continue;
    }
    const paragraph: string[] = [];
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i]))
      paragraph.push(lines[i++]);
    out.push(`<p>${paragraphLines(paragraph).join("<br>")}</p>`);
  }
  return out.join("");
}
