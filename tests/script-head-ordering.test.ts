/**
 * Regression tests for inline `<Script strategy="beforeInteractive">` head
 * ordering in the App Router.
 *
 * Background
 * ----------
 * The standard no-flash dark-mode pattern relies on a tiny inline initializer
 * running before stylesheets parse. React Float hoists stylesheet/preload/
 * modulepreload links to the top of `<head>` and pushes any user-rendered
 * `<script>` children below them — so a Script written first in source order
 * still ends up near the bottom of the head section, defeating the pattern.
 *
 * vinext captures inline `<Script strategy="beforeInteractive">` content via
 * `BeforeInteractiveContext` (set up in `app-ssr-entry.ts`) and the SSR stream
 * transform splices the captured tag in immediately after `<head ...>` opens,
 * before any React-emitted resource hints. These tests pin that ordering:
 *
 *   - inline beforeInteractive script appears before the first stylesheet
 *   - inline beforeInteractive script appears before the first modulepreload
 *   - inline beforeInteractive script appears before any other preload link
 *   - CSP nonce flows through to the hoisted tag
 *   - The Script's id/data-* attributes round-trip
 *   - No duplicate inline `<script>` appears later in head
 *
 * Failing the assertion below before the fix
 * ------------------------------------------
 * Before this fix, the inline `<Script strategy="beforeInteractive">` was
 * rendered inline by React in source order, where React Float's hoisted
 * links sat above it. `expect(scriptIndex).toBeLessThan(stylesheetIndex)`
 * would fail because Fizz reordered the head emit.
 */
import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import type { ViteDevServer } from "vite-plus";
import { APP_FIXTURE_DIR, fetchHtml, startFixtureServer } from "./helpers.js";

const ROUTE = "/beforeinteractive-head-ordering";

/**
 * Extract the substring between `<head ...>` and `</head>`. Tests only care
 * about ordering inside the head, and constraining the search there keeps
 * matches from drifting into the `<body>` content (e.g. the bootstrap
 * `<script type="module">` near the closing body tag).
 */
function extractHeadHtml(html: string): string {
  const openMatch = /<head\b[^>]*>/.exec(html);
  const closeIndex = html.indexOf("</head>");
  if (!openMatch || closeIndex === -1) {
    throw new Error("Response HTML did not contain a complete <head>...</head> section");
  }
  return html.slice(openMatch.index + openMatch[0].length, closeIndex);
}

type HoistedInlineScript = {
  index: number;
  tag: string;
  attrs: Record<string, string>;
  content: string;
};

/**
 * Find the hoisted loaders for inline beforeInteractive scripts. Each loader
 * carries `[[name, value], ...]` attribute pairs and the body as HTML-safe
 * JSON, which never contains `<`, so the first `)</script>` after the payload
 * ends it.
 */
function findHoistedInlineScripts(html: string): HoistedInlineScript[] {
  return [
    ...html.matchAll(/<script\b[^>]*>[^<]*\(document\.currentScript,([^<]*)\)<\/script[^>]*>/gi),
  ].map((match) => {
    const [attrs, content] = JSON.parse(match[1] ?? "") as [[string, string][], string];
    return {
      index: match.index,
      tag: /^<script\b[^>]*>/i.exec(match[0])?.[0] ?? "",
      attrs: Object.fromEntries(attrs),
      content,
    };
  });
}

function findHoistedInlineScript(html: string, id: string): HoistedInlineScript | undefined {
  return findHoistedInlineScripts(html).find((script) => script.attrs.id === id);
}

function indexOfMatch(html: string, pattern: RegExp): number {
  const match = pattern.exec(html);
  return match ? match.index : -1;
}

describe("inline beforeInteractive head ordering", () => {
  let server: ViteDevServer;
  let baseUrl: string;

  beforeAll(async () => {
    ({ server, baseUrl } = await startFixtureServer(APP_FIXTURE_DIR, {
      appRouter: true,
    }));
    await fetch(`${baseUrl}/`).catch(() => {});
  }, 60_000);

  afterAll(async () => {
    await server?.close();
  });

  it("emits the inline beforeInteractive <script> before the first stylesheet link", async () => {
    const { res, html } = await fetchHtml(baseUrl, ROUTE);
    expect(res.status).toBe(200);

    const head = extractHeadHtml(html);
    const scriptIndex = findHoistedInlineScript(head, "vinext-test-theme-init")?.index ?? -1;
    const stylesheetIndex = indexOfMatch(head, /<link\b[^>]*rel="stylesheet"/);

    expect(
      scriptIndex,
      "expected the inline beforeInteractive script to appear in <head>",
    ).toBeGreaterThanOrEqual(0);

    // When the test fixture has at least one stylesheet (Vite dev injects one
    // for HMR styles in dev, and the production build emits one per CSS
    // import), the script must precede it. We skip the assertion when no
    // stylesheet exists — the script still has to be present, asserted above.
    if (stylesheetIndex !== -1) {
      expect(scriptIndex).toBeLessThan(stylesheetIndex);
    }
  });

  it("emits the inline beforeInteractive <script> before the first modulepreload link", async () => {
    const { html } = await fetchHtml(baseUrl, ROUTE);
    const head = extractHeadHtml(html);

    const scriptIndex = findHoistedInlineScript(head, "vinext-test-theme-init")?.index ?? -1;
    const modulePreloadIndex = indexOfMatch(head, /<link\b[^>]*rel="modulepreload"/);

    expect(scriptIndex).toBeGreaterThanOrEqual(0);
    // The bootstrap modulepreload is always emitted, so this assertion is
    // unconditional. If the bootstrap is ever made optional, fall back to the
    // same "skip when absent" pattern used for stylesheets above.
    expect(modulePreloadIndex).toBeGreaterThanOrEqual(0);
    expect(scriptIndex).toBeLessThan(modulePreloadIndex);
  });

  it("emits the inline beforeInteractive <script> before every preload link", async () => {
    const { html } = await fetchHtml(baseUrl, ROUTE);
    const head = extractHeadHtml(html);
    const scriptIndex = findHoistedInlineScript(head, "vinext-test-theme-init")?.index ?? -1;
    expect(scriptIndex).toBeGreaterThanOrEqual(0);

    // Any preload link (stylesheet, script, font) emitted by React Float or
    // vinext must follow the inline script.
    for (const match of head.matchAll(
      /<link\b[^>]*rel="(?:preload|modulepreload|stylesheet)"[^>]*>/g,
    )) {
      expect(
        match.index,
        `link "${match[0]}" must appear after the theme-init script`,
      ).toBeGreaterThan(scriptIndex);
    }
  });

  it("does not duplicate the inline script inside <head>", async () => {
    const { html } = await fetchHtml(baseUrl, ROUTE);
    const head = extractHeadHtml(html);
    const hoisted = findHoistedInlineScripts(head).filter(
      (script) => script.attrs.id === "vinext-test-theme-init",
    );
    expect(hoisted).toHaveLength(1);
    expect(head).not.toMatch(/<script\b[^>]*id="vinext-test-theme-init"/);
  });

  it("preserves the inline script's body content", async () => {
    const { html } = await fetchHtml(baseUrl, ROUTE);
    expect(findHoistedInlineScript(html, "vinext-test-theme-init")?.content).toBe(
      "self.__vinextThemeInitRan = true;",
    );
  });

  it("keeps markup in inline script data out of the HTML", async () => {
    // The /beforeinteractive-script-data page embeds `<!--<script>`,
    // `</head>` and `</body></html>` in string data of an inline
    // beforeInteractive Script. Like Next.js, the hoisted tag carries the body
    // as HTML-safe JSON, so none of it can open a tag, close the script, or
    // match the stream's own `</head>` and `</body></html>` insertion points.
    const { res, html } = await fetchHtml(baseUrl, "/beforeinteractive-script-data");
    expect(res.status).toBe(200);
    const head = extractHeadHtml(html);
    expect(findHoistedInlineScript(head, "vinext-test-script-data")?.content).toBe(
      'self.__vinextScriptData = {"name":"<!--<script>","bio":"</head><p id=\\"profile-bio\\">bio</p></body></html>"};',
    );
    expect(head).not.toContain("<!--<script>");
    expect(head).not.toContain("<p id=");
    // The navigation runtime's own head scripts still land before the real
    // `</head>`, outside the hoisted payload.
    expect(head).toContain("vinext.navigationRuntime");
  });

  it("preserves passthrough attributes like data-*", async () => {
    const { html } = await fetchHtml(baseUrl, ROUTE);
    const head = extractHeadHtml(html);
    expect(findHoistedInlineScript(head, "vinext-test-theme-init")?.attrs).toMatchObject({
      "data-vinext-test": "theme-init",
      "data-nscript": "beforeInteractive",
    });
  });

  it("applies the CSP nonce header to the hoisted inline script", async () => {
    // The fixture's middleware reads `?csp-nonce=…` and sets a CSP header
    // with that nonce. vinext extracts the nonce and threads it through
    // ScriptNonceProvider, so the hoisted tag must carry the same value.
    const { res, html } = await fetchHtml(baseUrl, `${ROUTE}?csp-nonce=ordering-nonce`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toMatch(/nonce-ordering-nonce/);

    const head = extractHeadHtml(html);
    const hoisted = findHoistedInlineScript(head, "vinext-test-theme-init");
    expect(hoisted).toBeDefined();
    // The loader runs under the nonce, and so does the script it creates.
    expect(hoisted?.tag).toContain('nonce="ordering-nonce"');
    expect(hoisted?.attrs.nonce).toBe("ordering-nonce");
  });

  it("hoists external src beforeInteractive scripts into <head> with the data-nscript marker", async () => {
    // Regression for cloudflare/vinext#2016: external src beforeInteractive
    // scripts (the /script-nonce page renders Script src="/test2.js") are now
    // registered through BeforeInteractiveContext and hoisted into <head> just
    // like the inline form, mirroring Next.js which routes inline and src
    // beforeInteractive scripts equally through the App Router runtime. The
    // hoisted tag carries Next.js's `data-nscript="beforeInteractive"` marker.
    const { html } = await fetchHtml(baseUrl, "/script-nonce");
    const head = extractHeadHtml(html);
    const tagMatch = /<script\b[^>]*src="\/test2\.js"[^>]*>/.exec(head);
    expect(
      tagMatch,
      "expected the src beforeInteractive script to be hoisted into <head>",
    ).not.toBeNull();
    expect(tagMatch?.[0]).toContain('data-nscript="beforeInteractive"');
    // Exactly one tag — the client must not re-render a duplicate.
    const matches = [...html.matchAll(/<script\b[^>]*src="\/test2\.js"/g)];
    expect(matches).toHaveLength(1);
  });
});
