import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";
import { copyMissingOgWasm } from "../packages/vinext/src/plugins/og-assets.js";
import type { Plugin } from "vite-plus";
import fsp from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ── Helpers ───────────────────────────────────────────────────

function unwrapHook(hook: any): Function {
  return typeof hook === "function" ? hook : hook?.handler;
}

function createOgAssetsPlugin(): Plugin {
  const plugins = vinext() as Plugin[];
  const plugin = plugins.find((p) => p.name === "vinext:og-assets");
  if (!plugin) throw new Error("vinext:og-assets plugin not found");
  return plugin;
}

// A `this` context that mimics the rsc environment so the hooks run.
const rscCtx = { environment: { name: "rsc" } };

/** Build a fake output bundle (chunk + optional emitted wasm assets). */
function makeBundle(opts: {
  chunkCode: string;
  resvgAsset?: string;
  yogaAsset?: string;
  chunkFileName?: string;
}): Record<string, any> {
  const bundle: Record<string, any> = {
    [opts.chunkFileName ?? "_next/static/index.edge-AAA.js"]: {
      type: "chunk",
      fileName: opts.chunkFileName ?? "_next/static/index.edge-AAA.js",
      code: opts.chunkCode,
    },
  };
  if (opts.resvgAsset) {
    bundle[opts.resvgAsset] = { type: "asset", fileName: opts.resvgAsset };
  }
  if (opts.yogaAsset) {
    bundle[opts.yogaAsset] = { type: "asset", fileName: opts.yogaAsset };
  }
  return bundle;
}

// ── Test fixture setup ────────────────────────────────────────

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "og-assets-test-"));
});

afterAll(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

// ── Tests ─────────────────────────────────────────────────────

describe("vinext:og-assets plugin", () => {
  it("exists in the plugin array", () => {
    const plugin = createOgAssetsPlugin();
    expect(plugin.name).toBe("vinext:og-assets");
    expect(plugin.apply).toBe("build");
  });

  describe("dedup: emitted asset present", () => {
    it("rewrites the Node fallback new URL(...) to the emitted resvg/yoga asset", () => {
      const plugin = createOgAssetsPlugin();
      const generateBundle = unwrapHook(plugin.generateBundle);

      // Mirror the real (minified) shape: resvg uses backticks, the primary
      // ?module import already points at the hashed asset, the fallback points
      // at the bare base name. yoga uses double quotes.
      const chunkCode = [
        "var a=import(`./resvg-BBB.wasm`).then(m=>m.default).catch(function(){",
        "  return Promise.all([import(`node:fs`),import(`node:url`)]).then(function(e){",
        "    var t=e[1].fileURLToPath(new URL(`./resvg.wasm`,import.meta.url));",
        "    return e[0].promises.readFile(t).then(b=>WebAssembly.compile(b));",
        "  });",
        "});",
        'var b=import("./yoga-CCC.wasm").then(m=>m.default).catch(()=>null);',
        'var p=fileURLToPath(new URL("./yoga.wasm", import.meta.url));',
      ].join("\n");

      const bundle = makeBundle({
        chunkCode,
        resvgAsset: "_next/static/resvg-BBB.wasm",
        yogaAsset: "_next/static/yoga-CCC.wasm",
      });

      generateBundle.call(rscCtx, {}, bundle);

      const out = bundle["_next/static/index.edge-AAA.js"].code as string;

      // The fallback references now point at the emitted (sibling) assets.
      expect(out).toContain("new URL(`./resvg-BBB.wasm`, import.meta.url)");
      expect(out).toContain('new URL("./yoga-CCC.wasm", import.meta.url)');

      // The bare base-name fallback references are gone (no second copy needed).
      expect(out).not.toContain("new URL(`./resvg.wasm`");
      expect(out).not.toContain('new URL("./yoga.wasm"');
    });

    it("rewrites to a directory-relative ref when chunk and asset live in different dirs", () => {
      const plugin = createOgAssetsPlugin();
      const generateBundle = unwrapHook(plugin.generateBundle);

      // Chunk at the output root, emitted asset under _next/static/. At Node
      // runtime `new URL(ref, import.meta.url)` resolves relative to the chunk,
      // so the rewrite must produce a path that descends into _next/static/.
      const bundle = makeBundle({
        chunkCode: 'var p=new URL("./resvg.wasm", import.meta.url);',
        chunkFileName: "index.edge-AAA.js",
        resvgAsset: "_next/static/resvg-BBB.wasm",
      });

      generateBundle.call(rscCtx, {}, bundle);

      const out = bundle["index.edge-AAA.js"].code as string;
      expect(out).toContain('new URL("./_next/static/resvg-BBB.wasm", import.meta.url)');
      expect(out).not.toContain('new URL("./resvg.wasm"');
    });

    it("keeps the chunk sourcemap in sync when one is present", () => {
      const plugin = createOgAssetsPlugin();
      const generateBundle = unwrapHook(plugin.generateBundle);

      const chunkCode = 'var p=new URL("./yoga.wasm", import.meta.url);';
      const bundle = makeBundle({ chunkCode, yogaAsset: "_next/static/yoga-CCC.wasm" });
      // Attach a pre-existing (single-source) map to the chunk.
      bundle["_next/static/index.edge-AAA.js"].map = {
        version: 3,
        file: "index.edge-AAA.js",
        sources: ["index.edge-AAA.js"],
        names: [],
        mappings: "AAAA",
      };

      generateBundle.call(rscCtx, {}, bundle);

      const chunk = bundle["_next/static/index.edge-AAA.js"];
      // Code was rewritten…
      expect(chunk.code).toContain('new URL("./yoga-CCC.wasm", import.meta.url)');
      // …and the map remains a valid, non-null v3 map (magic-string regenerated).
      expect(chunk.map).toBeTruthy();
      expect(chunk.map.version).toBe(3);
      expect(typeof chunk.map.mappings).toBe("string");
      expect(chunk.map.mappings.length).toBeGreaterThan(0);
    });

    it("does NOT copy a second root copy when the asset was emitted", async () => {
      const plugin = createOgAssetsPlugin();
      const generateBundle = unwrapHook(plugin.generateBundle);
      const writeBundle = unwrapHook(plugin.writeBundle);

      const outDir = path.join(tmpDir, "deduped");
      await fsp.mkdir(outDir, { recursive: true });

      const chunkCode = [
        "import(`./resvg-BBB.wasm`);",
        "new URL(`./resvg.wasm`,import.meta.url);",
        'import("./yoga-CCC.wasm");',
        'new URL("./yoga.wasm", import.meta.url);',
      ].join("\n");

      const bundle = makeBundle({
        chunkCode,
        resvgAsset: "_next/static/resvg-BBB.wasm",
        yogaAsset: "_next/static/yoga-CCC.wasm",
      });

      generateBundle.call(rscCtx, {}, bundle);
      await writeBundle.call(rscCtx, { dir: outDir }, bundle);

      // No root resvg.wasm / yoga.wasm copies — the emitted assets are reused.
      expect(fs.existsSync(path.join(outDir, "resvg.wasm"))).toBe(false);
      expect(fs.existsSync(path.join(outDir, "yoga.wasm"))).toBe(false);
    });
  });

  describe("fallback: no emitted asset (copyMissingOgWasm helper)", () => {
    // Tested via the pure helper with an injected source dir so the assertion
    // is hermetic — it does not depend on the real @vercel/og install (whose
    // yoga.wasm only exists as a side effect of the og-font-patch transform).
    it("copies a single root copy of each referenced asset from the source dir", async () => {
      const sourceDir = path.join(tmpDir, "src-dist");
      const outDir = path.join(tmpDir, "copied");
      await fsp.mkdir(sourceDir, { recursive: true });
      await fsp.mkdir(outDir, { recursive: true });
      await fsp.writeFile(path.join(sourceDir, "resvg.wasm"), Buffer.from([0, 1, 2]));
      await fsp.writeFile(path.join(sourceDir, "yoga.wasm"), Buffer.from([3, 4, 5]));

      copyMissingOgWasm({ outDir, sourceDir, assets: ["resvg.wasm", "yoga.wasm"] });

      expect(fs.existsSync(path.join(outDir, "resvg.wasm"))).toBe(true);
      expect(fs.existsSync(path.join(outDir, "yoga.wasm"))).toBe(true);
    });

    it("skips assets missing from the source dir and never overwrites existing destinations", async () => {
      const sourceDir = path.join(tmpDir, "src-partial");
      const outDir = path.join(tmpDir, "copied-partial");
      await fsp.mkdir(sourceDir, { recursive: true });
      await fsp.mkdir(outDir, { recursive: true });
      // Only resvg exists in the source; yoga is absent.
      await fsp.writeFile(path.join(sourceDir, "resvg.wasm"), Buffer.from([9]));
      // A pre-existing destination must not be overwritten.
      await fsp.writeFile(path.join(outDir, "resvg.wasm"), Buffer.from([7, 7, 7]));

      copyMissingOgWasm({ outDir, sourceDir, assets: ["resvg.wasm", "yoga.wasm"] });

      // yoga.wasm not copied (no source); resvg.wasm left untouched (1 byte → 3 bytes would mean overwrite).
      expect(fs.existsSync(path.join(outDir, "yoga.wasm"))).toBe(false);
      expect(fs.readFileSync(path.join(outDir, "resvg.wasm"))).toEqual(Buffer.from([7, 7, 7]));
    });
  });

  describe("guards", () => {
    it("ignores non-rsc environments", () => {
      const plugin = createOgAssetsPlugin();
      const generateBundle = unwrapHook(plugin.generateBundle);

      const chunkCode = "new URL(`./resvg.wasm`,import.meta.url);";
      const bundle = makeBundle({ chunkCode, resvgAsset: "_next/static/resvg-BBB.wasm" });

      generateBundle.call({ environment: { name: "ssr" } }, {}, bundle);

      // Untouched: the ssr environment is not handled.
      expect(bundle["_next/static/index.edge-AAA.js"].code).toContain(
        "new URL(`./resvg.wasm`,import.meta.url)",
      );
    });
  });
});
