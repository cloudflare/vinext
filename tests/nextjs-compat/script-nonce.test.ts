import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import type { ViteDevServer } from "vite-plus";
import { APP_FIXTURE_DIR, fetchHtml, startFixtureServer } from "../helpers.js";

function getMatchingScriptTags(html: string, patterns: RegExp[]): string[] {
  return [...html.matchAll(/<script\b[^>]*>/g)]
    .map((match) => match[0])
    .filter((tag) => patterns.some((pattern) => pattern.test(tag)));
}

describe("Next.js compat: script nonce", () => {
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

  // Ported from Next.js: test/e2e/app-dir/app/index.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app/index.test.ts
  it("SSR: applies middleware nonce to next/script tags", async () => {
    const { res, html } = await fetchHtml(baseUrl, "/script-nonce");
    expect(res.headers.get("content-security-policy")).toBe(
      "script-src 'nonce-vinext-test-nonce' 'strict-dynamic';",
    );

    const tags = getMatchingScriptTags(html, [/src="\/test2\.js"/, /id="3"/]);
    expect(tags.length).toBeGreaterThan(0);
    for (const tag of tags) {
      expect(tag).toContain('nonce="vinext-test-nonce"');
    }
  });

  // Ported from Next.js: test/e2e/app-dir/app/index.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app/index.test.ts
  it("SSR: preserves manual nonce for App Router next/script tags", async () => {
    const { html } = await fetchHtml(baseUrl, "/script-manual-nonce");

    const tags = getMatchingScriptTags(html, [/src="\/test2\.js"/, /id="3"/]);
    expect(tags.length).toBeGreaterThan(0);
    for (const tag of tags) {
      expect(tag).toContain('nonce="hello-world"');
    }
  });

  // Ported from Next.js: test/e2e/app-dir/app/index.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app/index.test.ts
  it("SSR: preserves manual nonce for Pages Router next/script tags", async () => {
    const { html } = await fetchHtml(baseUrl, "/pages-script-manual-nonce");

    const tags = getMatchingScriptTags(html, [/src="\/test2\.js"/, /id="3"/]);
    expect(tags.length).toBeGreaterThan(0);
    for (const tag of tags) {
      expect(tag).toContain('nonce="hello-world"');
    }
  });

  // Ported from Next.js: test/e2e/app-dir/app/index.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app/index.test.ts
  it("SSR: passes middleware nonce through next/font output", async () => {
    const { res, html } = await fetchHtml(baseUrl, "/script-nonce/with-next-font");
    expect(res.headers.get("content-security-policy")).toBe(
      "script-src 'nonce-vinext-test-nonce' 'strict-dynamic';",
    );
    expect(html).toContain('id="script-nonce-font"');

    const fontTags = [
      ...html.matchAll(/<link\b[^>]*rel="(?:preload|stylesheet)"[^>]*>/g),
      ...html.matchAll(/<style\b[^>]*data-vinext-fonts[^>]*>/g),
    ].map((match) => match[0]);
    expect(fontTags.length).toBeGreaterThan(0);
    for (const tag of fontTags) {
      expect(tag).toContain('nonce="vinext-test-nonce"');
    }
  });
});
