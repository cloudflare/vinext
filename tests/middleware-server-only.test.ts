/**
 * Build-time integration test: middleware (and any module reachable from it)
 * must be allowed to `import 'server-only'`, even though vinext bundles
 * middleware into the SSR environment.
 *
 * Ported from Next.js: test/e2e/module-layer/module-layer.test.ts
 *   https://github.com/vercel/next.js/blob/canary/test/e2e/module-layer/module-layer.test.ts
 *   The fixture's `middleware.js` contains a top-level `import 'server-only'`
 *   plus a `react` import — Next.js's module-layer rules let `server-only`
 *   through for middleware (`WEBPACK_LAYERS.neutralTarget`) while still
 *   blocking it from client code.
 *
 * Before this fix, `@vitejs/plugin-rsc`'s `rsc:validate-imports` rejected
 * the import with:
 *
 *   'server-only' cannot be imported in client build ('ssr' environment):
 *     imported by middleware.js
 *       imported by virtual:vinext-server-entry
 *
 * That single build failure cascaded into 13 failures in the
 * `module-layer.test.ts` deploy suite, which is the failure pattern that
 * the upstream issue (#1344) tracks.
 */
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

const FIXTURE_PREFIX = "vinext-mw-server-only-";

async function writeFile(file: string, source: string): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, source, "utf8");
}

async function buildFixture(): Promise<{ tmpDir: string }> {
  const workspaceRoot = path.resolve(import.meta.dirname, "..");
  const workspaceNodeModules = path.join(workspaceRoot, "node_modules");

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), FIXTURE_PREFIX));

  // Hybrid App + Pages Router fixture. The Next.js module-layer test has
  // both directories, and that combination is what makes the SSR entry
  // (which contains the bare \`import 'server-only'\` statement coming from
  // middleware) reachable from \`virtual:vinext-app-ssr-entry\` — see the
  // hybrid re-export branch in src/entries/app-ssr-entry.ts. With only
  // app/, the App Router SSR environment never imports the Pages Router
  // virtual server entry, so plugin-rsc's validate-imports buildEnd pass
  // never sees the \`server-only\` chain. The hybrid fixture mirrors what
  // the deploy suite actually builds.
  await writeFile(
    path.join(tmpDir, "app", "layout.tsx"),
    `export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
`,
  );
  await writeFile(
    path.join(tmpDir, "app", "page.tsx"),
    `export default function Home() { return <div>home</div>; }\n`,
  );
  // Pages Router companion route — its mere presence flips
  // \`hasPagesDir\` and triggers the SSR-entry → server-entry re-export.
  await writeFile(
    path.join(tmpDir, "pages", "pages-ssr.tsx"),
    `export default function PagesSsr() { return <div>pages-ssr</div>; }\n`,
  );

  // A helper that the middleware imports. Mirrors the Next.js fixture's
  // `lib/mixed-lib`-style transitive case: `server-only` must remain a
  // no-op when reached two hops away from the middleware entry.
  //
  // Marked side-effectful via an exported sentinel so Rolldown does NOT
  // tree-shake the module and its `import 'server-only'` out of the bundle.
  // The Next.js fixture has the same property by virtue of `react` being
  // an actual runtime dependency of the middleware; we keep ours minimal.
  await writeFile(
    path.join(tmpDir, "lib", "auth.ts"),
    `import "server-only";

// Side-effectful top-level export to anchor the module against tree-shaking.
export const __AUTH_TAG = "vinext-test-tag-" + Date.now().toString(36);
export function getUserId(): string {
  return __AUTH_TAG;
}
`,
  );

  // Middleware with a direct \`import 'server-only'\` (the failure surface
  // reported in the issue) and a transitive one through ./lib/auth.
  //
  // Mirrors the Next.js module-layer fixture's middleware.js, which also
  // imports \`import * as React from 'react'\` — React is what anchors the
  // server-side module so DCE cannot drop the server-only chain. We keep
  // the React assertion to match the upstream fixture's intent: even though
  // React is bundled, its client-side hooks (\`useState\`) must NOT appear
  // in the server-layer copy.
  await writeFile(
    path.join(tmpDir, "middleware.ts"),
    `import "server-only";
import * as React from "react";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getUserId } from "./lib/auth";

export function middleware(request: NextRequest) {
  // Match the Next.js fixture's React-in-server-layer assertion so the
  // \`react\` import is genuinely live and Rolldown cannot tree-shake it.
  const ReactObject = Object(React);
  if (ReactObject.useState) {
    throw new Error("React.useState should not be defined in server layer");
  }
  // Use the helper's result in a header so Rolldown's DCE pass cannot drop
  // either the helper module or its top-level \`import 'server-only'\`.
  const response = NextResponse.next();
  response.headers.set("x-vinext-test-user", getUserId());
  response.headers.set("x-vinext-test-react-keys", Object.keys(ReactObject).length.toString());
  return response;
}

export const config = { matcher: ["/"] };
`,
  );

  // Symlink workspace node_modules so vinext, react, react-dom resolve.
  await fsp.symlink(workspaceNodeModules, path.join(tmpDir, "node_modules"), "junction");

  const { default: vinext } = await import(
    pathToFileURL(path.join(workspaceRoot, "packages/vinext/src/index.ts")).href
  );
  const { createBuilder } = await import("vite");
  const rscOutDir = path.join(tmpDir, "dist", "server");
  const ssrOutDir = path.join(tmpDir, "dist", "server", "ssr");
  const clientOutDir = path.join(tmpDir, "dist", "client");

  const builder = await createBuilder({
    root: tmpDir,
    configFile: false,
    plugins: [vinext({ appDir: tmpDir, rscOutDir, ssrOutDir, clientOutDir })],
    logLevel: "error",
  });

  await builder.buildApp();
  return { tmpDir };
}

async function buildPagesClientServerOnlyViolationFixture(): Promise<void> {
  const workspaceRoot = path.resolve(import.meta.dirname, "..");
  const workspaceNodeModules = path.join(workspaceRoot, "node_modules");
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-pages-server-only-"));

  await writeFile(
    path.join(tmpDir, "pages", "index.tsx"),
    `import Comp from "../components/Comp";

export default function Page() {
  return <Comp />;
}
`,
  );
  await writeFile(
    path.join(tmpDir, "components", "Comp.tsx"),
    `import "server-only";

export default function Comp() {
  return <p>hello world</p>;
}
`,
  );

  await fsp.symlink(workspaceNodeModules, path.join(tmpDir, "node_modules"), "junction");

  const { default: vinext } = await import(
    pathToFileURL(path.join(workspaceRoot, "packages/vinext/src/index.ts")).href
  );
  const { createBuilder } = await import("vite");
  const rscOutDir = path.join(tmpDir, "dist", "server");
  const ssrOutDir = path.join(tmpDir, "dist", "server", "ssr");
  const clientOutDir = path.join(tmpDir, "dist", "client");

  const builder = await createBuilder({
    root: tmpDir,
    configFile: false,
    plugins: [vinext({ appDir: tmpDir, rscOutDir, ssrOutDir, clientOutDir })],
    logLevel: "error",
  });

  await builder.buildApp();
}

async function buildAppServerActionServerOnlyFixture(): Promise<void> {
  const workspaceRoot = path.resolve(import.meta.dirname, "..");
  const workspaceNodeModules = path.join(workspaceRoot, "node_modules");
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-action-server-only-"));

  await writeFile(
    path.join(tmpDir, "app", "layout.tsx"),
    `export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
`,
  );
  // A Server Actions module ("use server") that imports server-only. This
  // mirrors Next.js's own fixture, which is valid because server actions run
  // in the server/action layer — not the client layer that server-only guards.
  await writeFile(
    path.join(tmpDir, "app", "actions.ts"),
    `'use server'

import 'server-only'

export async function inc(value: number) {
  return value + 1;
}
`,
  );
  // A client component that references the action. This is what pulls the
  // action module into the client environment graph, where the
  // vinext:validate-server-only-client-imports guard runs.
  await writeFile(
    path.join(tmpDir, "app", "counter.tsx"),
    `'use client'

import { useState } from "react";
import { inc } from "./actions";

export default function Counter() {
  const [value, setValue] = useState(0);
  return <button onClick={async () => setValue(await inc(value))}>{value}</button>;
}
`,
  );
  await writeFile(
    path.join(tmpDir, "app", "page.tsx"),
    `import Counter from "./counter";

export default function Home() {
  return <Counter />;
}
`,
  );

  await fsp.symlink(workspaceNodeModules, path.join(tmpDir, "node_modules"), "junction");

  const { default: vinext } = await import(
    pathToFileURL(path.join(workspaceRoot, "packages/vinext/src/index.ts")).href
  );
  const { createBuilder } = await import("vite");
  const rscOutDir = path.join(tmpDir, "dist", "server");
  const ssrOutDir = path.join(tmpDir, "dist", "server", "ssr");
  const clientOutDir = path.join(tmpDir, "dist", "client");

  const builder = await createBuilder({
    root: tmpDir,
    configFile: false,
    plugins: [vinext({ appDir: tmpDir, rscOutDir, ssrOutDir, clientOutDir })],
    logLevel: "error",
  });

  await builder.buildApp();
}

describe("middleware can import server-only", () => {
  let tmpDir: string;

  beforeAll(async () => {
    const built = await buildFixture();
    tmpDir = built.tmpDir;
  }, 120_000);

  afterAll(() => {
    // tmpdirs are left for post-mortem debugging; the test harness cleans
    // os.tmpdir() periodically. Matching the pattern used by other build
    // integration tests (build-time-classification-integration.test.ts).
  });

  async function collectServerJsFiles(): Promise<string[]> {
    // App Router default output layout:
    //   dist/server/index.{js,mjs}      ← RSC entry
    //   dist/server/ssr/*.{js,mjs}      ← SSR pass for client components
    //   dist/client/assets/*.js         ← browser bundle
    const serverDir = path.join(tmpDir, "dist", "server");
    const stack: string[] = [serverDir];
    const seen: string[] = [];
    while (stack.length) {
      const current = stack.pop()!;
      const entries = await fsp.readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (/\.(m?js)$/.test(entry.name)) seen.push(full);
      }
    }
    return seen;
  }

  it("emits server bundles without an invalid-server-only stub", async () => {
    // The validate-imports plugin replaces an invalid bare `server-only`
    // specifier with a virtual module body of:
    //   throw new Error("invalid import of 'server-only'")
    // If our taint-tracking plugin works, that string must not appear in any
    // server-side artifact (it would appear in the SSR pass if middleware's
    // chain were rejected). We check both the RSC entry and the SSR dir to
    // catch regressions in either environment.
    const files = await collectServerJsFiles();
    expect(
      files.length,
      `expected JS artifacts under dist/server (got: ${files.length})`,
    ).toBeGreaterThan(0);
    for (const file of files) {
      const source = await fsp.readFile(file, "utf8");
      expect(
        source.includes("invalid import of 'server-only'"),
        `${path.relative(tmpDir, file)} contains the rsc:validate-imports throw stub`,
      ).toBe(false);
    }
  });

  it("keeps the middleware (and its server-only chain) in the bundle", async () => {
    // Sanity check: prove the fixture isn't trivially passing because Rolldown
    // tree-shook the middleware out before validate-imports could see it. If
    // \`getUserId\`'s body (the \`__AUTH_TAG\` constant) is reachable in the
    // emitted artifacts, the middleware → lib/auth.ts → server-only chain
    // really did survive into the build that validate-imports inspects.
    const files = await collectServerJsFiles();
    const found = await Promise.all(
      files.map(async (f) => (await fsp.readFile(f, "utf8")).includes("vinext-test-tag-")),
    );
    expect(
      found.some(Boolean),
      "expected lib/auth's __AUTH_TAG sentinel to appear in at least one server artifact",
    ).toBe(true);
  });
});

describe("Pages Router client builds reject server-only", () => {
  it("errors when a Pages client graph imports server-only", async () => {
    // Ported from Next.js: test/development/acceptance/server-component-compiler-errors-in-pages.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/development/acceptance/server-component-compiler-errors-in-pages.test.ts
    await expect(buildPagesClientServerOnlyViolationFixture()).rejects.toThrow(
      /server-only.*Server Components in the App Router/s,
    );
  });
});

describe("App Router Server Actions can import server-only", () => {
  it("builds when a 'use server' module imports server-only", async () => {
    // Mirrors Next.js's test/e2e/app-dir/actions fixture, whose
    // app/client/actions.js is a `'use server'` module with `import 'server-only'`.
    // Server Actions run in the server/action layer, so server-only is allowed
    // even though the client bundle references the actions to invoke them.
    // The validate-server-only-client-imports guard (added in #1697) must not
    // false-positive on these or it breaks the whole client build — regression
    // test for the actions/app-basepath deploy-suite failures.
    await expect(buildAppServerActionServerOnlyFixture()).resolves.toBeUndefined();
  }, 120_000);
});
