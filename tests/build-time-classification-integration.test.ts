/**
 * Build-time layout classification integration tests.
 *
 * These tests build a real App Router fixture through the full Vite pipeline,
 * then extract the generated __VINEXT_CLASS dispatch function from the emitted
 * RSC chunk and evaluate it. They verify that Fix 2 (wiring the build-time
 * classifier into the plugin's generateBundle hook) actually produces a
 * populated dispatch table at the end of the build pipeline — previously every
 * route fell back to the Layer 3 runtime probe because the plugin never ran
 * the classifier.
 */
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

const FIXTURE_PREFIX = "vinext-class-integration-";

type Dispatch = (routeIdx: number) => Map<unknown, unknown> | null;

type BuiltFixture = {
  chunkSource: string;
  dispatch: Dispatch;
  routeIndexByPattern: Map<string, number>;
};

async function writeFile(file: string, source: string): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, source, "utf8");
}

/**
 * Extracts the __VINEXT_CLASS function body from the RSC chunk source and
 * evaluates it to a callable dispatch function. Throws if the stub is still
 * the untouched `return null` form — the caller is expected to have patched
 * it via the plugin's generateBundle hook.
 */
function extractDispatch(chunkSource: string): Dispatch {
  const stubRe = /function\s+__VINEXT_CLASS\s*\(routeIdx\)\s*\{\s*return null;?\s*\}/;
  if (stubRe.test(chunkSource)) {
    throw new Error("__VINEXT_CLASS was not patched — still returns null unconditionally");
  }

  // Non-greedy match: assumes the inner dispatch body does not contain
  // ')(routeIdx)' as a substring. Coupled to the codegen shape in
  // route-classification-manifest.ts buildGenerateBundleReplacement.
  const re =
    /function\s+__VINEXT_CLASS\s*\(routeIdx\)\s*\{\s*return\s+(\([\s\S]*?\))\(routeIdx\);\s*\}/;
  const match = re.exec(chunkSource);
  if (!match) {
    throw new Error("Could not locate patched __VINEXT_CLASS in chunk source");
  }

  // Use vm.runInThisContext so the resulting Map instances share their
  // prototype with the test process — `instanceof Map` would otherwise
  // fail across v8 contexts.
  const raw: unknown = vm.runInThisContext(match[1]!);
  if (typeof raw !== "function") {
    throw new Error("Patched __VINEXT_CLASS body did not evaluate to a function");
  }
  return (routeIdx: number) => {
    const result: unknown = Reflect.apply(raw, null, [routeIdx]);
    if (result === null) return null;
    if (result instanceof Map) return result;
    throw new Error(
      `Dispatch returned unexpected value for routeIdx ${routeIdx}: ${JSON.stringify(result)}`,
    );
  };
}

/**
 * Extracts the per-route route indices emitted in the `routes = [...]` table
 * by matching `__VINEXT_CLASS(N)` call expressions alongside each pattern.
 * Maps pattern strings (stable across test edits) to numeric indices.
 */
function extractRouteIndexByPattern(chunkSource: string): Map<string, number> {
  const result = new Map<string, number>();
  const re = /__buildTimeClassifications:\s*__VINEXT_CLASS\((\d+)\)[\s\S]*?pattern:\s*"([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(chunkSource)) !== null) {
    result.set(match[2]!, Number(match[1]!));
  }
  if (result.size === 0) {
    throw new Error("No route entries with __VINEXT_CLASS + pattern found in chunk source");
  }
  return result;
}

async function buildMinimalFixture({
  debug = false,
}: { debug?: boolean } = {}): Promise<BuiltFixture> {
  const workspaceRoot = path.resolve(import.meta.dirname, "..");
  const workspaceNodeModules = path.join(workspaceRoot, "node_modules");

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), FIXTURE_PREFIX));

  // Root layout — plain JSX, no segment config, no dynamic shim imports.
  // Layer 2 should prove this "static".
  await writeFile(
    path.join(tmpDir, "app", "layout.tsx"),
    `export default function RootLayout({ children }) {
  return <html><body>{children}</body></html>;
}`,
  );

  // "/" — force-dynamic layout above a plain page.
  await writeFile(
    path.join(tmpDir, "app", "page.tsx"),
    `export default function Home() { return <div>home</div>; }`,
  );

  // "/dyn" — nested layout that uses next/headers, should remain unclassified
  // (Layer 2 returns "needs-probe", filtered out).
  await writeFile(
    path.join(tmpDir, "app", "dyn", "layout.tsx"),
    `import { headers } from "next/headers";
export default async function DynLayout({ children }) {
  const h = await headers();
  void h;
  return <section>{children}</section>;
}`,
  );
  await writeFile(
    path.join(tmpDir, "app", "dyn", "page.tsx"),
    `export default function DynPage() { return <div>dyn</div>; }`,
  );

  // "/force-dyn" — segment config force-dynamic at the layout.
  await writeFile(
    path.join(tmpDir, "app", "force-dyn", "layout.tsx"),
    `export const dynamic = "force-dynamic";
export default function ForceDynLayout({ children }) {
  return <section>{children}</section>;
}`,
  );
  await writeFile(
    path.join(tmpDir, "app", "force-dyn", "page.tsx"),
    `export default function ForceDynPage() { return <div>fd</div>; }`,
  );

  // "/force-static" — segment config force-static at the layout.
  await writeFile(
    path.join(tmpDir, "app", "force-static", "layout.tsx"),
    `export const dynamic = "force-static";
export default function ForceStaticLayout({ children }) {
  return <section>{children}</section>;
}`,
  );
  await writeFile(
    path.join(tmpDir, "app", "force-static", "page.tsx"),
    `export default function ForceStaticPage() { return <div>fs</div>; }`,
  );

  // Symlink workspace node_modules so vinext, react, react-dom resolve.
  await fsp.symlink(workspaceNodeModules, path.join(tmpDir, "node_modules"), "junction");

  const outDir = await fsp.mkdtemp(path.join(os.tmpdir(), `${FIXTURE_PREFIX}out-`));
  const rscOutDir = path.join(outDir, "server");
  const ssrOutDir = path.join(outDir, "server", "ssr");
  const clientOutDir = path.join(outDir, "client");

  const { default: vinext } = await import(
    pathToFileURL(path.join(workspaceRoot, "packages/vinext/src/index.ts")).href
  );
  const { createBuilder } = await import("vite");
  const builder = await createBuilder({
    root: tmpDir,
    configFile: false,
    plugins: [vinext({ appDir: tmpDir, rscOutDir, ssrOutDir, clientOutDir })],
    logLevel: "silent",
  });

  // The plugin reads `VINEXT_DEBUG_CLASSIFICATION` directly from `process.env`
  // in its `generateBundle` hook. Save, override, and restore around the build
  // so these tests are hermetic: asserting "stub stays null" works even when
  // a developer has the flag set in their local shell, and the debug-on suite
  // below can force the patched path without polluting the sibling suite.
  const envKey = "VINEXT_DEBUG_CLASSIFICATION";
  const prior = process.env[envKey];
  if (debug) {
    process.env[envKey] = "1";
  } else {
    delete process.env[envKey];
  }
  try {
    await builder.buildApp();
  } finally {
    if (prior === undefined) {
      delete process.env[envKey];
    } else {
      process.env[envKey] = prior;
    }
  }

  // The RSC entry is emitted as either server/index.js or server/index.mjs
  // depending on whether the fixture has a package.json with "type": "module".
  // Our bespoke fixture has no package.json at all, so Vite falls back to .mjs.
  const chunkDir = path.join(outDir, "server");
  const entries = await fsp.readdir(chunkDir);
  const chunkFile = entries.find((f) => /^index\.m?js$/.test(f));
  if (!chunkFile) {
    throw new Error(`No RSC entry chunk found in ${chunkDir}. Contents: ${entries.join(", ")}`);
  }
  const chunkSource = await fsp.readFile(path.join(chunkDir, chunkFile), "utf8");

  return {
    chunkSource,
    dispatch: extractDispatch(chunkSource),
    routeIndexByPattern: extractRouteIndexByPattern(chunkSource),
  };
}

describe("build-time classification integration", () => {
  let built: BuiltFixture;

  beforeAll(async () => {
    built = await buildMinimalFixture();
  }, 120_000);

  afterAll(() => {
    // tmpdirs are left for post-mortem debugging; the test harness cleans
    // os.tmpdir() periodically. Matching the pattern used by buildAppFixture.
  });

  // (the dispatch-was-patched contract is enforced by extractDispatch in
  // beforeAll — if the stub still returned null, every other test below
  // would also fail with a clearer setup error).

  it("gates the reasons sidecar behind __classDebug in the route table", () => {
    expect(built.chunkSource).toMatch(
      /__buildTimeReasons:\s*__classDebug\s*\?\s*__VINEXT_CLASS_REASONS\(\d+\)\s*:\s*null/,
    );
  });

  it("leaves __VINEXT_CLASS_REASONS as a null stub when build-time debug is off", () => {
    expect(built.chunkSource).toMatch(
      /function\s+__VINEXT_CLASS_REASONS\s*\(routeIdx\)\s*\{\s*return null;?\s*\}/,
    );
    expect(built.chunkSource).not.toMatch(
      /function\s+__VINEXT_CLASS_REASONS\s*\(routeIdx\)\s*\{[^}]*switch/,
    );
  });

  it("classifies the force-dynamic layout at build time", () => {
    const routeIdx = built.routeIndexByPattern.get("/force-dyn");
    expect(routeIdx).toBeDefined();
    const map = built.dispatch(routeIdx!);
    expect(map).toBeInstanceOf(Map);
    // Layout index 1 is the nested `/force-dyn/layout.tsx`; index 0 is root.
    expect(map!.get(1)).toBe("dynamic");
  });

  it("classifies the force-static layout at build time", () => {
    const routeIdx = built.routeIndexByPattern.get("/force-static");
    expect(routeIdx).toBeDefined();
    const map = built.dispatch(routeIdx!);
    expect(map).toBeInstanceOf(Map);
    expect(map!.get(1)).toBe("static");
  });

  it("omits layouts that import next/headers from the build-time map", () => {
    const routeIdx = built.routeIndexByPattern.get("/dyn");
    expect(routeIdx).toBeDefined();
    const map = built.dispatch(routeIdx!);
    // The nested layout at index 1 pulls in next/headers, so Layer 2 returns
    // "needs-probe" — it must be filtered out and fall back to Layer 3 at
    // request time.
    if (map) {
      expect(map.has(1)).toBe(false);
    }
  });

  it("classifies layouts with no segment config and no dynamic shims as static", () => {
    // The root layout at index 0 is pure JSX — Layer 2 should prove it static.
    // This assertion holds for every route in the fixture since they all share
    // the root layout.
    const routeIdx = built.routeIndexByPattern.get("/");
    expect(routeIdx).toBeDefined();
    const map = built.dispatch(routeIdx!);
    expect(map).toBeInstanceOf(Map);
    expect(map!.get(0)).toBe("static");
  });
});

/**
 * Extracts and evaluates `__VINEXT_CLASS_REASONS` from a build output that was
 * produced with `VINEXT_DEBUG_CLASSIFICATION=1`. Mirrors `extractDispatch` but
 * targets the sibling reasons stub. Kept intentionally permissive about the
 * emitted codegen shape so this test survives the #863 refactor.
 */
type ReasonShape = { layer: string; result?: string };

function isReasonShape(value: unknown): value is ReasonShape {
  if (!value || typeof value !== "object") return false;
  if (!("layer" in value)) return false;
  return typeof value.layer === "string";
}

function extractReasonsDispatch(
  chunkSource: string,
): (routeIdx: number) => Map<number, ReasonShape> | null {
  const stubRe = /function\s+__VINEXT_CLASS_REASONS\s*\(routeIdx\)\s*\{\s*return null;?\s*\}/;
  if (stubRe.test(chunkSource)) {
    throw new Error("__VINEXT_CLASS_REASONS was not patched despite VINEXT_DEBUG_CLASSIFICATION=1");
  }
  const re =
    /function\s+__VINEXT_CLASS_REASONS\s*\(routeIdx\)\s*\{\s*return\s+(\([\s\S]*?\))\(routeIdx\);\s*\}/;
  const match = re.exec(chunkSource);
  if (!match) {
    throw new Error("Could not locate patched __VINEXT_CLASS_REASONS in chunk source");
  }
  const raw: unknown = vm.runInThisContext(match[1]!);
  if (typeof raw !== "function") {
    throw new Error("Patched __VINEXT_CLASS_REASONS body did not evaluate to a function");
  }
  return (routeIdx: number) => {
    const result: unknown = Reflect.apply(raw, null, [routeIdx]);
    if (result === null) return null;
    if (result instanceof Map) {
      const narrowed = new Map<number, ReasonShape>();
      for (const [key, value] of result) {
        if (typeof key !== "number") {
          throw new Error(`Reasons dispatch returned non-numeric key: ${String(key)}`);
        }
        if (!isReasonShape(value)) {
          throw new Error(`Reasons dispatch returned malformed reason: ${JSON.stringify(value)}`);
        }
        narrowed.set(key, value);
      }
      return narrowed;
    }
    throw new Error(
      `Reasons dispatch returned unexpected value for routeIdx ${routeIdx}: ${JSON.stringify(result)}`,
    );
  };
}

describe("build-time classification integration (debug on)", () => {
  let built: BuiltFixture;

  beforeAll(async () => {
    built = await buildMinimalFixture({ debug: true });
  }, 120_000);

  it("patches __VINEXT_CLASS_REASONS with a populated dispatcher", () => {
    expect(built.chunkSource).toMatch(
      /function\s+__VINEXT_CLASS_REASONS\s*\(routeIdx\)\s*\{[^}]*switch/,
    );
    expect(built.chunkSource).not.toMatch(
      /function\s+__VINEXT_CLASS_REASONS\s*\(routeIdx\)\s*\{\s*return null;?\s*\}/,
    );
  });

  it("emits both Layer 1 and Layer 2 reasons on the force-dyn route dispatch entry", () => {
    // Only the discriminator + Layer 2 `result` are pinned so the test
    // survives the #863 codegen reshape.
    const reasonsFor = extractReasonsDispatch(built.chunkSource);
    const routeIdx = built.routeIndexByPattern.get("/force-dyn");
    expect(routeIdx).toBeDefined();
    const reasons = reasonsFor(routeIdx!);
    expect(reasons).toBeInstanceOf(Map);

    const nestedReason = reasons!.get(1);
    expect(nestedReason).toBeDefined();
    expect(nestedReason!.layer).toBe("segment-config");

    const rootReason = reasons!.get(0);
    expect(rootReason).toBeDefined();
    expect(rootReason!.layer).toBe("module-graph");
    expect(rootReason!.result).toBe("static");
  });
});
