/**
 * Tests for Phase 2 of static pre-rendering.
 *
 * Tests:
 * 1. Production server serving pre-rendered HTML from dist/server/pages/
 * 2. prerenderStaticPages() function existence and return type
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { Server } from "node:http";

const PAGES_FIXTURE = path.resolve(import.meta.dirname, "./fixtures/pages-basic");

// ─── Production server — serves pre-rendered HTML ─────────────────────────────

const outDir = path.resolve(PAGES_FIXTURE, "dist");
const serverEntryPath = path.join(outDir, "server", "entry.js");
const fixtureBuilt = fs.existsSync(serverEntryPath);
if (!fixtureBuilt) {
  console.warn(
    `[build-prerender] fixture not built — skipping production-server tests. ` +
      `Run \`pnpm build\` inside ${PAGES_FIXTURE} to enable them.`,
  );
}

// Sentinel: fail loudly in CI when the fixture hasn't been built instead of
// silently passing an empty suite. The skipIf block below is for local dev
// convenience only — CI must always build the fixture before running this file
// (the build step runs `pnpm build` inside the fixture directory).
it("fixture must be built before running pre-render tests", () => {
  if (!fixtureBuilt) {
    throw new Error(
      `Pre-render fixture not built.\n` +
        `  Local dev: run \`pnpm build\` inside ${PAGES_FIXTURE}\n` +
        `  CI: ensure the build step runs before the test step`,
    );
  }
});

describe.skipIf(!fixtureBuilt)("Production server — serves pre-rendered HTML", () => {
  const pagesDir = path.join(outDir, "server", "pages");
  const prerenderedFile = path.join(pagesDir, "prerendered-test.html");
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    // Clear any stale files left by a previous failed run before creating test fixtures.
    fs.rmSync(pagesDir, { recursive: true, force: true });
    // Create a fake pre-rendered HTML file at dist/server/pages/prerendered-test.html
    fs.mkdirSync(pagesDir, { recursive: true });
    fs.writeFileSync(
      prerenderedFile,
      `<!DOCTYPE html><html><head><title>Pre-rendered</title></head><body><div id="__next">Pre-rendered test content</div></body></html>`,
      "utf-8",
    );

    try {
      const { startProdServer } = await import("../packages/vinext/src/server/prod-server.js");
      server = await startProdServer({
        port: 0,
        host: "127.0.0.1",
        outDir,
      });
      const addr = server.address() as { port: number };
      baseUrl = `http://127.0.0.1:${addr.port}`;
    } catch (e) {
      // Clean up test files if server startup fails so subsequent runs aren't affected.
      // Use recursive removal for consistency with afterAll — targeted cleanup can miss
      // files left by earlier failed tests.
      fs.rmSync(pagesDir, { recursive: true, force: true });
      throw e;
    }
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    // Recursively clean all test-created files under pagesDir.
    // Using recursive removal protects against stale files left behind if a
    // test fails between writeFileSync and its own finally block (e.g. the
    // nested pre-rendered HTML test or the index.html test).
    if (fs.existsSync(pagesDir)) {
      fs.rmSync(pagesDir, { recursive: true, force: true });
    }
  });

  it("serves pre-rendered HTML for /prerendered-test", async () => {
    const res = await fetch(`${baseUrl}/prerendered-test`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Pre-rendered test content");
  });

  it("serves pre-rendered HTML with text/html content type", async () => {
    const res = await fetch(`${baseUrl}/prerendered-test`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  it("serves pre-rendered HTML with Cache-Control header for CDN caching", async () => {
    const res = await fetch(`${baseUrl}/prerendered-test`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("s-maxage=3600, stale-while-revalidate=86400");
    await res.text(); // consume body
  });

  it("always serves pre-rendered HTML with status 200, ignoring middleware rewrite status", async () => {
    // Pre-rendered files are served unconditionally as 200. A middleware
    // NextResponse.rewrite() with a non-200 status is only meaningful when
    // the page is rendered dynamically — forwarding that status alongside a
    // cached HTML body would be semantically wrong.
    const res = await fetch(`${baseUrl}/prerendered-test`);
    expect(res.status).toBe(200);
    await res.text();
  });

  it("falls back to SSR when no pre-rendered file exists", async () => {
    // /about is a real page in pages-basic but has no pre-rendered file.
    // Assert the file is absent so this test is not vacuous.
    const aboutFile = path.join(pagesDir, "about.html");
    expect(
      fs.existsSync(aboutFile),
      "about.html must not exist in pagesDir for this test to be meaningful",
    ).toBe(false);

    const res = await fetch(`${baseUrl}/about`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("About");
  });

  it("serves nested pre-rendered HTML (e.g. /blog/hello-world)", async () => {
    // Create a nested pre-rendered file simulating a dynamic route
    const nestedDir = path.join(pagesDir, "blog");
    const nestedFile = path.join(nestedDir, "hello-world.html");
    fs.mkdirSync(nestedDir, { recursive: true });
    fs.writeFileSync(
      nestedFile,
      `<!DOCTYPE html><html><body>Blog post content</body></html>`,
      "utf-8",
    );

    try {
      const res = await fetch(`${baseUrl}/blog/hello-world`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Blog post content");
    } finally {
      fs.rmSync(nestedFile);
      if (fs.existsSync(nestedDir) && fs.readdirSync(nestedDir).length === 0) {
        fs.rmdirSync(nestedDir);
      }
    }
  });

  it("serves pre-rendered index.html for /", async () => {
    // This test creates the file AFTER the server starts. It works because
    // resolvePrerenderedHtml calls fs.existsSync on every request rather than
    // caching the directory listing at startup — so new files are picked up
    // immediately without a server restart.
    const indexFile = path.join(pagesDir, "index.html");
    fs.writeFileSync(
      indexFile,
      `<!DOCTYPE html><html><body>Pre-rendered home</body></html>`,
      "utf-8",
    );

    try {
      const res = await fetch(`${baseUrl}/`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Pre-rendered home");
    } finally {
      fs.rmSync(indexFile);
    }
  });

  it("serves pre-rendered about/index.html for /about (trailingSlash:true layout)", async () => {
    // When trailingSlash is true, getOutputPath writes pages as <name>/index.html
    // instead of <name>.html. resolvePrerenderedHtml checks both patterns, so
    // about/index.html should be served at /about regardless of config.
    const aboutDir = path.join(pagesDir, "about");
    const aboutFile = path.join(aboutDir, "index.html");
    fs.mkdirSync(aboutDir, { recursive: true });
    fs.writeFileSync(
      aboutFile,
      `<!DOCTYPE html><html><body>Pre-rendered about (trailing slash)</body></html>`,
      "utf-8",
    );

    try {
      const res = await fetch(`${baseUrl}/about`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Pre-rendered about (trailing slash)");
    } finally {
      fs.rmSync(aboutFile);
      if (fs.existsSync(aboutDir) && fs.readdirSync(aboutDir).length === 0) {
        fs.rmdirSync(aboutDir);
      }
    }
  });
});

// ─── prerenderStaticPages — function exists ───────────────────────────────────

describe("prerenderStaticPages — function exists", () => {
  it("prerenderStaticPages is exported as a function", async () => {
    const mod = await import("../packages/vinext/src/build/static-export.js");
    expect(typeof mod.prerenderStaticPages).toBe("function");
  });

  it.skipIf(!fixtureBuilt)("PrerenderResult type is returned", async () => {
    const { prerenderStaticPages } = await import("../packages/vinext/src/build/static-export.js");
    // Call with the pages-basic fixture which has a built dist/
    const result = await prerenderStaticPages({ root: PAGES_FIXTURE });
    expect(result).toHaveProperty("pageCount");
    expect(result).toHaveProperty("files");
    expect(result).toHaveProperty("warnings");
    expect(result).toHaveProperty("skipped");
    // Verify the function actually ran and produced meaningful output — not
    // just an empty early-return. The pages-basic fixture has at least one
    // static page (index), so pageCount must be > 0.
    expect(result.pageCount).toBeGreaterThan(0);
    expect(result.files.length).toBeGreaterThan(0);
  });
});

// ─── getOutputPath — path-traversal guard ────────────────────────────────────

describe("getOutputPath — path-traversal guard", () => {
  // URL inputs always start with '/', so path.posix.normalize can never
  // produce a path above '/' (e.g. "/../etc/passwd" normalizes to "/etc/passwd").
  // The boundary check therefore prevents traversal for non-URL-derived paths
  // such as those coming directly from generateStaticParams/getStaticPaths on
  // Windows (where path.sep is '\' and path.resolve uses drive roots).
  // We verify the safe paths and the fact that suspicious-looking inputs are
  // normalized to safe outputs rather than throwing.

  it("normalizes traversal segments — /../etc/passwd maps to /etc/passwd within outDir", async () => {
    const { getOutputPath } = await import("../packages/vinext/src/build/static-export.js");
    // path.posix.normalize("/../etc/passwd") === "/etc/passwd", so this
    // resolves to /tmp/out/etc/passwd.html — within bounds.
    expect(getOutputPath("/../etc/passwd", false, "/tmp/out")).toBe("etc/passwd.html");
  });

  it("normalizes multi-level traversal — /../../secret maps to /secret within outDir", async () => {
    const { getOutputPath } = await import("../packages/vinext/src/build/static-export.js");
    // path.posix.normalize("/../../secret") === "/secret", so this
    // resolves to /tmp/out/secret.html — within bounds.
    expect(getOutputPath("/../../secret", false, "/tmp/out")).toBe("secret.html");
  });

  it("accepts normal paths within the output directory", async () => {
    const { getOutputPath } = await import("../packages/vinext/src/build/static-export.js");
    expect(getOutputPath("/about", false, "/tmp/out")).toBe("about.html");
    expect(getOutputPath("/blog/hello-world", false, "/tmp/out")).toBe("blog/hello-world.html");
    expect(getOutputPath("/", false, "/tmp/out")).toBe("index.html");
  });
});
