/**
 * Tests for scripts/classify-nextjs-suites.mjs.
 *
 * The classifier reads from a Next.js checkout on disk, so each test creates
 * a tiny fake Next.js checkout under a tmpdir, populates it with a fixture
 * directory structure that exercises a specific bucket (see strategy notes
 * in the script header), and asserts the right router kind is returned.
 *
 * Buckets covered:
 *   - App Router only (real app/, no pages/)
 *   - Pages Router only (real pages/, no app/)
 *   - Both (genuine parity test fixture)
 *   - App Router test with stub pages/ that has no real routes (still "app")
 *   - Pages Router test with stub app/ that has no real routes (still "pages")
 *   - app-dir/ inline fixture (no on-disk routes, falls back to "app")
 *   - Truly unclassifiable (config/build test, returns "unknown")
 *   - pageExtensions (page.page.js / layout.page.js still recognised)
 *   - test/ subdir (fixture lives one level up from the .test.ts)
 *   - APP_ROUTER_NON_APP_DIR_SUITES curated override
 */
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vite-plus/test";

import { classifySuite } from "../scripts/classify-nextjs-suites.mjs";

async function writeFile(file: string, contents = "") {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, contents);
}

describe("classifySuite", () => {
  let root: string;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "classify-nextjs-"));
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("classifies an App Router-only fixture as 'app'", async () => {
    const suite = "test/e2e/my-app-test/my-app-test.test.ts";
    await writeFile(path.join(root, suite));
    await writeFile(path.join(root, "test/e2e/my-app-test/app/page.tsx"));
    await writeFile(path.join(root, "test/e2e/my-app-test/app/layout.tsx"));

    expect(classifySuite(root, suite)).toBe("app");
  });

  it("classifies a Pages Router-only fixture as 'pages'", async () => {
    const suite = "test/e2e/my-pages-test/my-pages-test.test.ts";
    await writeFile(path.join(root, suite));
    await writeFile(path.join(root, "test/e2e/my-pages-test/pages/index.tsx"));
    await writeFile(path.join(root, "test/e2e/my-pages-test/pages/blog/[slug].tsx"));

    expect(classifySuite(root, suite)).toBe("pages");
  });

  it("classifies a fixture with both real app/ and pages/ as 'both'", async () => {
    const suite = "test/e2e/parity-test/parity-test.test.ts";
    await writeFile(path.join(root, suite));
    await writeFile(path.join(root, "test/e2e/parity-test/app/page.tsx"));
    await writeFile(path.join(root, "test/e2e/parity-test/pages/old.tsx"));

    expect(classifySuite(root, suite)).toBe("both");
  });

  it("ignores a stub pages/ with only Pages-Router specials (_app, _document)", async () => {
    const suite = "test/e2e/stub-pages/stub-pages.test.ts";
    await writeFile(path.join(root, suite));
    await writeFile(path.join(root, "test/e2e/stub-pages/app/page.tsx"));
    await writeFile(path.join(root, "test/e2e/stub-pages/pages/_app.tsx"));
    await writeFile(path.join(root, "test/e2e/stub-pages/pages/_document.tsx"));

    expect(classifySuite(root, suite)).toBe("app");
  });

  it("ignores a stub app/ with no real route files", async () => {
    const suite = "test/e2e/stub-app/stub-app.test.ts";
    await writeFile(path.join(root, suite));
    await writeFile(path.join(root, "test/e2e/stub-app/pages/index.tsx"));
    // app/ exists but has no page/layout/route/default — just a helper.
    await writeFile(path.join(root, "test/e2e/stub-app/app/helper.ts"));

    expect(classifySuite(root, suite)).toBe("pages");
  });

  it("falls back to 'app' for inline-fixture suites under test/e2e/app-dir/", async () => {
    // The .test.ts builds its fixture via nextTestSetup({ files: { ... } })
    // — no on-disk app/ or pages/ exists. Path convention says App Router.
    const suite = "test/e2e/app-dir/inline-fixture/inline-fixture.test.ts";
    await writeFile(path.join(root, suite));

    expect(classifySuite(root, suite)).toBe("app");
  });

  it("returns 'unknown' for inline-fixture suites outside app-dir/", async () => {
    // No path convention to fall back on, no on-disk fixture.
    const suite = "test/e2e/config-test/config-test.test.ts";
    await writeFile(path.join(root, suite));

    expect(classifySuite(root, suite)).toBe("unknown");
  });

  it("recognises pageExtensions-style file names (layout.page.tsx, page.page.js)", async () => {
    const suite = "test/e2e/app-dir/page-ext/index.test.ts";
    await writeFile(path.join(root, suite));
    await writeFile(path.join(root, "test/e2e/app-dir/page-ext/app/layout.page.tsx"));
    await writeFile(path.join(root, "test/e2e/app-dir/page-ext/app/foo/page.page.js"));

    expect(classifySuite(root, suite)).toBe("app");
  });

  it("walks up from `test/` subdir when the .test.ts lives in a test/ folder", async () => {
    // Mirrors Next.js's pattern:
    //   test/e2e/middleware-base-path/test/index.test.ts
    //   test/e2e/middleware-base-path/app/...
    const suite = "test/e2e/with-test-subdir/test/index.test.ts";
    await writeFile(path.join(root, suite));
    await writeFile(path.join(root, "test/e2e/with-test-subdir/app/page.tsx"));

    expect(classifySuite(root, suite)).toBe("app");
  });

  it("honours the curated APP_ROUTER_NON_APP_DIR_SUITES list", async () => {
    // This suite is hand-marked as App Router even though it doesn't live
    // under test/e2e/app-dir/ and has no on-disk fixture.
    const suite = "test/e2e/next-form/default/next-form-prefetch.test.ts";
    // Don't write the file — verify the fallback fires when statSync fails.

    expect(classifySuite(root, suite)).toBe("app");
  });

  it("respects an explicit overrides map", async () => {
    const suite = "test/e2e/some/file.test.ts";
    await writeFile(path.join(root, suite));
    await writeFile(path.join(root, "test/e2e/some/pages/index.tsx"));

    // Heuristic would say "pages"; overrides force "both".
    expect(classifySuite(root, suite, { [suite]: "both" })).toBe("both");
  });

  it("classifies pages/api routes as real Pages Router routes", async () => {
    // pages/api/* are real routes — fixtures that only have API routes
    // are still Pages Router fixtures.
    const suite = "test/e2e/api-only/index.test.ts";
    await writeFile(path.join(root, suite));
    await writeFile(path.join(root, "test/e2e/api-only/pages/api/hello.ts"));

    expect(classifySuite(root, suite)).toBe("pages");
  });

  it("returns 'unknown' when the test file does not exist", async () => {
    // Missing test file with no app-dir/ prefix → unknown.
    expect(classifySuite(root, "test/e2e/missing/missing.test.ts")).toBe("unknown");
  });

  it("does not walk into node_modules / .next when scanning fixtures", async () => {
    const suite = "test/e2e/with-noise/with-noise.test.ts";
    await writeFile(path.join(root, suite));
    await writeFile(path.join(root, "test/e2e/with-noise/pages/index.tsx"));
    // A node_modules dir contains a package with its own app/page.tsx —
    // this must NOT cause the suite to be classified as "both".
    await writeFile(path.join(root, "test/e2e/with-noise/node_modules/some-pkg/app/page.tsx"));
    await writeFile(path.join(root, "test/e2e/with-noise/.next/server/app/page.js"));

    expect(classifySuite(root, suite)).toBe("pages");
  });
});
