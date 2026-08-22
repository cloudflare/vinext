/**
 * A small GitHub-Flavored Markdown renderer, scoped to what the vinext README
 * actually uses.
 *
 * This exists instead of the usual unified/remark/rehype stack because those
 * packages are not declared dependencies of `apps/web`, and adding them would
 * require unfreezing the lockfile. It runs at build time only — see
 * ./readme-html.ts — so none of it is shipped to the Worker.
 *
 * Supported: ATX headings (with slug ids), fenced code, GFM tables, ordered and
 * unordered lists with nesting, blockquotes, thematic breaks, paragraphs,
 * `<details>`/`<summary>` passthrough, and inline code/strong/emphasis/links.
 * Anything outside that set is emitted as escaped text rather than guessed at.
 */

export type Heading = { depth: number; text: string; slug: string };

export type RenderOptions = {
  /** Build-time syntax highlighter. Returns full `<pre>` markup, or null to fall back. */
  highlight?: (code: string, lang: string | null) => string | null;
  /** Rewrites every link href. Used to absolutise the README's repo-relative links. */
  rewriteLink?: (href: string) => string;
  /**
   * Shifts every heading down by this many levels, so an embedded document can
   * sit under the host page's own <h1> without introducing a second one.
   */
  headingOffset?: number;
};

export type RenderResult = { html: string; headings: Heading[] };

const RAW_PASSTHROUGH = /^<\/?(?:details|summary)(?:\s[^>]*)?>/;
const FENCE = /^(?:```|~~~)\s*([A-Za-z0-9_+-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const THEMATIC_BREAK = /^(?:-{3,}|\*{3,}|_{3,})$/;
const UNORDERED_ITEM = /^(\s*)[-*+]\s+(.*)$/;
const ORDERED_ITEM = /^(\s*)(\d+)[.)]\s+(.*)$/;
const TABLE_DELIMITER = /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/;

/** Placeholder for extracted code spans. NUL cannot occur in the markdown source. */
const CODE_MARKER = "\u0000";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** GitHub's heading slug rules, so in-README anchor links keep working. */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
}

function uniqueSlug(base: string, seen: Map<string, number>): string {
  const count = seen.get(base) ?? 0;
  seen.set(base, count + 1);
  return count === 0 ? base : `${base}-${count}`;
}

/**
 * Inline pass. Code spans are extracted first and re-inserted last, so their
 * contents are never treated as markup.
 */
function renderInline(src: string, options: RenderOptions): string {
  const codeSpans: string[] = [];
  let text = src.replace(/(`+)([\s\S]*?)\1/g, (_match, _ticks: string, code: string) => {
    const position = codeSpans.push(`<code>${escapeHtml(code.trim())}</code>`) - 1;
    return `${CODE_MARKER}${position}${CODE_MARKER}`;
  });

  text = escapeHtml(text);

  // Images before links: the two syntaxes differ only by the leading "!".
  text = text.replace(
    /!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g,
    (_m, alt: string, src2: string) => {
      const href = options.rewriteLink ? options.rewriteLink(src2) : src2;
      return `<img src="${href}" alt="${alt}" loading="lazy" />`;
    },
  );

  text = text.replace(
    /\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g,
    (_m, label: string, url: string) => {
      const href = options.rewriteLink ? options.rewriteLink(url) : url;

      let external = false;
      if (/^https?:\/\//i.test(href)) {
        try {
          const parsed = new URL(href);
          external = !(parsed.protocol === "https:" && parsed.hostname === "vinext.dev");
        } catch {
          external = true;
        }
      }

      const attrs = external ? ' target="_blank" rel="noopener noreferrer"' : "";
      return `<a href="${href}"${attrs}>${label}</a>`;
    },
  );

  text = text.replace(
    /&lt;(https?:\/\/[^&\s]+)&gt;/g,
    (_m, url: string) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`,
  );

  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
  text = text.replace(/~~([^~]+)~~/g, "<del>$1</del>");

  return text.replace(
    new RegExp(`${CODE_MARKER}(\\d+)${CODE_MARKER}`, "g"),
    (_m, position: string) => codeSpans[Number(position)],
  );
}

function splitTableRow(line: string): string[] {
  return line
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function alignmentsOf(delimiter: string): (string | null)[] {
  return splitTableRow(delimiter).map((cell) => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    if (left) return "left";
    return null;
  });
}

export function renderMarkdown(source: string, options: RenderOptions = {}): RenderResult {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const headings: Heading[] = [];
  const slugs = new Map<string, number>();
  const out: string[] = [];
  let index = 0;

  const inline = (value: string) => renderInline(value, options);

  /** Renders a run of lines that belong to one container, so nesting works. */
  const renderNested = (block: string[]): string => {
    if (block.length === 0) return "";
    const nested = renderMarkdown(block.join("\n"), options);
    headings.push(...nested.headings);
    return nested.html;
  };

  while (index < lines.length) {
    const line = lines[index];

    if (line.trim() === "") {
      index += 1;
      continue;
    }

    // Fenced code
    const fence = FENCE.exec(line);
    if (fence) {
      const lang = fence[1] || null;
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !FENCE.test(lines[index])) {
        body.push(lines[index]);
        index += 1;
      }
      index += 1; // closing fence
      const code = body.join("\n");
      const highlighted = options.highlight?.(code, lang) ?? null;
      out.push(
        highlighted ??
          `<pre><code${lang ? ` class="language-${lang}"` : ""}>${escapeHtml(code)}</code></pre>`,
      );
      continue;
    }

    // Raw <details>/<summary> passthrough. Content between the tags is parsed as
    // ordinary markdown, matching GitHub's behaviour.
    if (RAW_PASSTHROUGH.test(line.trim())) {
      const trimmed = line.trim();
      const summary = /^<summary(?:\s[^>]*)?>([\s\S]*?)<\/summary>$/.exec(trimmed);
      out.push(summary ? `<summary>${inline(summary[1])}</summary>` : trimmed);
      index += 1;
      continue;
    }

    // Heading
    const heading = HEADING.exec(line);
    if (heading) {
      const depth = Math.min(6, heading[1].length + (options.headingOffset ?? 0));
      const text = heading[2];
      const slug = uniqueSlug(slugify(text), slugs);
      headings.push({ depth, text, slug });
      out.push(`<h${depth} id="${slug}">${inline(text)}</h${depth}>`);
      index += 1;
      continue;
    }

    if (THEMATIC_BREAK.test(line.trim())) {
      out.push("<hr />");
      index += 1;
      continue;
    }

    // Blockquote
    if (line.startsWith(">")) {
      const body: string[] = [];
      while (index < lines.length && lines[index].startsWith(">")) {
        body.push(lines[index].replace(/^>\s?/, ""));
        index += 1;
      }
      out.push(`<blockquote>${renderNested(body)}</blockquote>`);
      continue;
    }

    // GFM table: a header row followed by a delimiter row
    if (line.includes("|") && index + 1 < lines.length && TABLE_DELIMITER.test(lines[index + 1])) {
      const header = splitTableRow(line);
      const aligns = alignmentsOf(lines[index + 1]);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && lines[index].includes("|") && lines[index].trim() !== "") {
        rows.push(splitTableRow(lines[index]));
        index += 1;
      }
      const align = (position: number) =>
        aligns[position] ? ` style="text-align:${aligns[position]}"` : "";
      const head = header
        .map((cell, position) => `<th${align(position)}>${inline(cell)}</th>`)
        .join("");
      const body = rows
        .map(
          (row) =>
            `<tr>${row
              .map((cell, position) => `<td${align(position)}>${inline(cell)}</td>`)
              .join("")}</tr>`,
        )
        .join("");
      out.push(
        `<div class="vinext-table-scroll"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`,
      );
      continue;
    }

    // Lists
    const unordered = UNORDERED_ITEM.exec(line);
    const ordered = ORDERED_ITEM.exec(line);
    if (unordered || ordered) {
      const isOrdered = ordered !== null;
      const baseIndent = (isOrdered ? ordered[1] : unordered![1]).length;
      const items: string[] = [];

      while (index < lines.length) {
        const current = lines[index];
        const itemMatch = isOrdered ? ORDERED_ITEM.exec(current) : UNORDERED_ITEM.exec(current);
        if (itemMatch === null || itemMatch[1].length !== baseIndent) break;

        const first = isOrdered ? itemMatch[3] : itemMatch[2];
        const continuation: string[] = [];
        index += 1;

        // Absorb continuation lines and any deeper-indented nested blocks.
        while (index < lines.length) {
          const next = lines[index];
          if (next.trim() === "") {
            const after = lines[index + 1] ?? "";
            const deeper = after.trim() !== "" && after.search(/\S/) > baseIndent;
            if (!deeper) break;
            continuation.push("");
            index += 1;
            continue;
          }
          if (next.search(/\S/) <= baseIndent) break;
          continuation.push(next.slice(baseIndent + 2));
          index += 1;
        }

        const nested = continuation.some((entry) => entry.trim() !== "")
          ? renderNested(continuation)
          : "";
        items.push(`<li>${inline(first)}${nested}</li>`);
      }

      const tag = isOrdered ? "ol" : "ul";
      out.push(`<${tag}>${items.join("")}</${tag}>`);
      continue;
    }

    // Paragraph: consume until a blank line or the start of another block.
    const paragraph: string[] = [];
    while (index < lines.length) {
      const current = lines[index];
      if (
        current.trim() === "" ||
        FENCE.test(current) ||
        HEADING.test(current) ||
        THEMATIC_BREAK.test(current.trim()) ||
        RAW_PASSTHROUGH.test(current.trim()) ||
        current.startsWith(">") ||
        UNORDERED_ITEM.test(current) ||
        ORDERED_ITEM.test(current)
      ) {
        break;
      }
      paragraph.push(current.trim());
      index += 1;
    }
    if (paragraph.length > 0) out.push(`<p>${inline(paragraph.join(" "))}</p>`);
  }

  return { html: out.join("\n"), headings };
}
