import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { renderMarkdown, type Heading } from "./markdown";

/**
 * Renders the repo README to HTML at build time and exposes it as a virtual
 * module, so /readme ships as plain markup with no markdown parser in the
 * Worker bundle.
 *
 * Build time rather than request time is deliberate: the README only changes
 * between deploys, and a runtime pipeline would cost roughly 120 KB of gzipped
 * Worker bundle plus shiki grammar compilation on every cold render.
 */

const VIRTUAL_ID = "virtual:vinext-readme";
const RESOLVED_ID = `\0${VIRTUAL_ID}`;

const REPO_URL = "https://github.com/cloudflare/vinext";
const README_PATH = path.resolve(fileURLToPath(import.meta.url), "../../../../README.md");

/** shiki language ids, keyed by the fence labels the README actually uses. */
const LANGUAGE_ALIASES: Record<string, string> = {
  bash: "bash",
  sh: "bash",
  shell: "bash",
  shellscript: "bash",
  zsh: "bash",
  json: "json",
  jsonc: "jsonc",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  typescript: "typescript",
  tsx: "tsx",
};

/**
 * The README lives at the repo root, so its relative links point at paths that
 * do not exist under vinext.dev. Anchors stay on-page because the renderer
 * emits GitHub-compatible heading ids; everything else resolves to GitHub.
 */
function rewriteLink(href: string): string {
  if (href.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) {
    return href;
  }
  const clean = href.replace(/^\.\//, "");
  const kind = /\.[a-z]+$/i.test(clean) ? "blob" : "tree";
  return `${REPO_URL}/${kind}/main/${clean}`;
}

async function createHighlight(): Promise<(code: string, lang: string | null) => string | null> {
  const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, ...langs] = await Promise.all([
    import("shiki/core"),
    import("shiki/engine/javascript"),
    import("shiki/langs/typescript.mjs"),
    import("shiki/langs/tsx.mjs"),
    import("shiki/langs/bash.mjs"),
    import("shiki/langs/json.mjs"),
    import("shiki/langs/jsonc.mjs"),
  ]);
  const theme = await import("shiki/themes/github-dark-default.mjs");

  const highlighter = await createHighlighterCore({
    langs,
    themes: [theme],
    engine: createJavaScriptRegexEngine(),
  });

  return (code, lang) => {
    const resolved = lang ? LANGUAGE_ALIASES[lang.toLowerCase()] : undefined;
    if (!resolved) return null;
    return highlighter.codeToHtml(code, { lang: resolved, theme: "github-dark-default" });
  };
}

type ReadmeModule = { html: string; headings: Heading[]; sourceUrl: string };

export function readmeHtmlPlugin(): Plugin {
  let highlight: Awaited<ReturnType<typeof createHighlight>> | undefined;

  return {
    name: "vinext-web:readme-html",
    resolveId(id) {
      return id === VIRTUAL_ID ? RESOLVED_ID : null;
    },
    async load(id) {
      if (id !== RESOLVED_ID) return null;

      // `this.addWatchFile` keeps dev in sync when the README is edited.
      this.addWatchFile(README_PATH);

      highlight ??= await createHighlight();
      const source = await readFile(README_PATH, "utf8");
      // Offset by one: the page supplies its own <h1>, so the README's h1
      // becomes an h2 and the document keeps a single top-level heading.
      const { html, headings } = renderMarkdown(source, {
        highlight,
        rewriteLink,
        headingOffset: 1,
      });

      const module: ReadmeModule = {
        html,
        headings,
        sourceUrl: `${REPO_URL}/blob/main/README.md`,
      };
      return `export default ${JSON.stringify(module)};`;
    },
  };
}
