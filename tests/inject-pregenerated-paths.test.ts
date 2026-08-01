import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { injectPregeneratedConcretePaths } from "../packages/vinext/src/build/inject-pregenerated-paths.js";
import { clearPregeneratedConcretePaths } from "../packages/vinext/src/server/pregenerated-concrete-paths.js";

let tmpDir: string;

function writeFile(relativePath: string, content: string): void {
  const filePath = path.join(tmpDir, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-pregenerated-paths-test-"));
});

afterEach(() => {
  clearPregeneratedConcretePaths();
  delete globalThis.__VINEXT_PREGENERATED_CONCRETE_PATHS;
  delete globalThis.__VINEXT_RSC_PREWARM_MANIFEST_URL;
  delete globalThis.__VINEXT_RSC_PREWARMABLE_PATHS;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("injectPregeneratedConcretePaths", () => {
  it("replaces an earlier injection", () => {
    writeFile("dist/server/index.js", 'import { handler } from "vinext/server/fetch-handler";\n');
    writeFile(
      "dist/server/vinext-prerender.json",
      JSON.stringify({
        buildId: "build-a",
        pregeneratedConcretePaths: [["/blog/:slug", ["/blog/post-a"]]],
      }),
    );
    injectPregeneratedConcretePaths(tmpDir);

    writeFile(
      "dist/server/vinext-prerender.json",
      JSON.stringify({
        buildId: "build-b",
        pregeneratedConcretePaths: [["/blog/:slug", ["/blog/post-b"]]],
      }),
    );
    injectPregeneratedConcretePaths(tmpDir);

    const output = fs.readFileSync(path.join(tmpDir, "dist/server/index.js"), "utf-8");
    expect(output).toContain("post-b");
    expect(output).not.toContain("post-a");
    expect(output).toContain('import { handler } from "vinext/server/fetch-handler"');
  });

  it("strips an earlier injection when the manifest is missing", () => {
    writeFile(
      "dist/server/index.js",
      [
        "/* __VINEXT_PREGENERATED_CONCRETE_PATHS_START__ */",
        'globalThis.__VINEXT_PREGENERATED_CONCRETE_PATHS = [["/blog/:slug",["/blog/post-a"]]];',
        "/* __VINEXT_PREGENERATED_CONCRETE_PATHS_END__ */",
        'import { handler } from "vinext/server/fetch-handler";',
        "",
      ].join("\n"),
    );

    injectPregeneratedConcretePaths(tmpDir);

    const output = fs.readFileSync(path.join(tmpDir, "dist/server/index.js"), "utf-8");
    expect(output).not.toContain("__VINEXT_PREGENERATED_CONCRETE_PATHS");
    expect(output).toContain('import { handler } from "vinext/server/fetch-handler"');
  });

  it("uses the concrete-path table stored in the prerender manifest", () => {
    writeFile(
      "dist/server/index.js",
      'export default { fetch() { return new Response("ok"); } };\n',
    );
    writeFile(
      "dist/server/vinext-prerender.json",
      JSON.stringify({
        buildId: "test",
        pregeneratedConcretePaths: [["/blog/:slug", ["/blog/post-a"]]],
      }),
    );

    injectPregeneratedConcretePaths(tmpDir);

    const output = fs.readFileSync(path.join(tmpDir, "dist/server/index.js"), "utf-8");
    const match = output.match(/globalThis\.__VINEXT_PREGENERATED_CONCRETE_PATHS = (\[.*?\]);/);
    expect(match).not.toBeNull();
    expect(JSON.parse(match![1])).toEqual([["/blog/:slug", ["/blog/post-a"]]]);
    expect(globalThis.__VINEXT_PREGENERATED_CONCRETE_PATHS).toEqual([
      ["/blog/:slug", ["/blog/post-a"]],
    ]);
  });

  it("clears the current-process global when no concrete paths are available", () => {
    globalThis.__VINEXT_PREGENERATED_CONCRETE_PATHS = [["/old/:slug", ["/old/post"]]];
    writeFile(
      "dist/server/index.js",
      [
        "/* __VINEXT_PREGENERATED_CONCRETE_PATHS_START__ */",
        'globalThis.__VINEXT_PREGENERATED_CONCRETE_PATHS = [["/old/:slug",["/old/post"]]];',
        "/* __VINEXT_PREGENERATED_CONCRETE_PATHS_END__ */",
        'export default { fetch() { return new Response("ok"); } };',
        "",
      ].join("\n"),
    );

    injectPregeneratedConcretePaths(tmpDir);

    expect(globalThis.__VINEXT_PREGENERATED_CONCRETE_PATHS).toBeUndefined();
  });

  it("hydrates the concrete-path registry from the generated Worker entry", async () => {
    const registryModuleUrl = pathToFileURL(
      path.resolve("packages/vinext/src/server/pregenerated-concrete-paths.ts"),
    ).href;
    writeFile(
      "dist/server/index.js",
      [
        `import { getRenderedConcreteUrlPathsForRoute, initPregeneratedPathsFromGlobals } from ${JSON.stringify(registryModuleUrl)};`,
        "initPregeneratedPathsFromGlobals();",
        'export const renderedPaths = [...(getRenderedConcreteUrlPathsForRoute("/blog/:slug") ?? [])];',
        'export default { fetch() { return new Response("ok"); } };',
        "",
      ].join("\n"),
    );
    writeFile(
      "dist/server/vinext-prerender.json",
      JSON.stringify({
        buildId: "test",
        pregeneratedConcretePaths: [["/blog/:slug", ["/blog/post-a"]]],
      }),
    );

    injectPregeneratedConcretePaths(tmpDir);

    const entryUrl = pathToFileURL(path.join(tmpDir, "dist/server/index.js")).href;
    const workerEntry: unknown = await import(`${entryUrl}?t=${Date.now()}`);
    expect(workerEntry).toMatchObject({ renderedPaths: ["/blog/post-a"] });
  });

  it("strips an earlier injection when the manifest is corrupt", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    writeFile(
      "dist/server/index.js",
      [
        "/* __VINEXT_PREGENERATED_CONCRETE_PATHS_START__ */",
        'globalThis.__VINEXT_PREGENERATED_CONCRETE_PATHS = [["/",["/"]]];',
        "/* __VINEXT_PREGENERATED_CONCRETE_PATHS_END__ */",
        'export default { fetch() { return new Response("ok"); } };',
        "",
      ].join("\n"),
    );
    writeFile("dist/server/vinext-prerender.json", "{invalid json}");

    injectPregeneratedConcretePaths(tmpDir);

    const output = fs.readFileSync(path.join(tmpDir, "dist/server/index.js"), "utf-8");
    expect(output).not.toContain("__VINEXT_PREGENERATED_CONCRETE_PATHS");
    expect(output).toContain('export default { fetch() { return new Response("ok"); } }');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[vinext] Failed to read prerender manifest"),
      expect.any(SyntaxError),
    );
  });

  it("emits a content-hashed eligibility asset from final cacheable App results", () => {
    writeFile(
      "dist/server/index.js",
      'export default { fetch() { return new Response("ok"); } };\n',
    );
    writeFile(
      "dist/server/vinext-prerender.json",
      JSON.stringify({
        buildId: "test",
        routes: [
          {
            route: "/static",
            status: "rendered",
            router: "app",
            revalidate: false,
            fallback: false,
          },
          {
            route: "/posts/:slug",
            path: "/posts/first/",
            status: "rendered",
            router: "app",
            revalidate: 60,
            fallback: false,
          },
          {
            route: "/dynamic",
            status: "skipped",
            router: "app",
            revalidate: false,
            fallback: false,
          },
          {
            route: "/private",
            status: "rendered",
            router: "app",
            revalidate: false,
            fallback: false,
            headers: { "Cache-Control": "private, no-store" },
          },
          {
            route: "/pages",
            status: "rendered",
            router: "pages",
            revalidate: false,
            fallback: false,
          },
        ],
      }),
    );
    writeFile(
      "dist/server/prerendered-routes/static.html",
      "<html><head></head><body>static</body></html>",
    );

    injectPregeneratedConcretePaths(tmpDir, {
      deploymentId: "deploy-a",
      emitRscPrewarmManifest: true,
    });

    const assetsDir = path.join(tmpDir, "dist/client/_next/static");
    const assetNames = fs
      .readdirSync(assetsDir)
      .filter((name) => /^vinext-rsc-prewarm-[a-f0-9]{16}\.json$/.test(name));
    expect(assetNames).toHaveLength(1);
    const assetContent = fs.readFileSync(path.join(assetsDir, assetNames[0]), "utf-8");
    const contentHash = createHash("sha256").update(assetContent).digest("hex").slice(0, 16);
    expect(assetNames[0]).toBe(`vinext-rsc-prewarm-${contentHash}.json`);
    expect(JSON.parse(assetContent)).toEqual({
      version: 1,
      paths: ["/static", "/posts/first"],
    });

    const output = fs.readFileSync(path.join(tmpDir, "dist/server/index.js"), "utf-8");
    expect(output).toContain(
      `globalThis.__VINEXT_RSC_PREWARM_MANIFEST_URL = "/_next/static/${assetNames[0]}?dpl=deploy-a";`,
    );
    expect(output).toContain(
      'globalThis.__VINEXT_RSC_PREWARMABLE_PATHS = ["/static","/posts/first"];',
    );
    expect(
      fs.readFileSync(path.join(tmpDir, "dist/server/prerendered-routes/static.html"), "utf-8"),
    ).toContain(`name="vinext-rsc-prewarm-manifest"`);
  });

  it("emits eligibility metadata for static export HTML without a Worker entry", () => {
    writeFile(
      "dist/server/vinext-prerender.json",
      JSON.stringify({
        routes: [
          {
            route: "/about",
            status: "rendered",
            router: "app",
            revalidate: false,
            fallback: false,
          },
        ],
      }),
    );
    writeFile("dist/client/about.html", "<html><head></head><body>about</body></html>");

    injectPregeneratedConcretePaths(tmpDir, { emitRscPrewarmManifest: true });

    expect(fs.readFileSync(path.join(tmpDir, "dist/client/about.html"), "utf-8")).toContain(
      'name="vinext-rsc-prewarm-manifest"',
    );
    expect(
      fs
        .readdirSync(path.join(tmpDir, "dist/client/_next/static"))
        .some((name) => /^vinext-rsc-prewarm-[a-f0-9]{16}\.json$/.test(name)),
    ).toBe(true);
  });

  it("changes the eligibility asset hash with its content and removes the stale asset", () => {
    writeFile(
      "dist/server/index.js",
      'export default { fetch() { return new Response("ok"); } };\n',
    );
    writeFile(
      "dist/server/vinext-prerender.json",
      JSON.stringify({
        routes: [
          {
            route: "/first",
            status: "rendered",
            router: "app",
            revalidate: false,
            fallback: false,
          },
        ],
      }),
    );
    injectPregeneratedConcretePaths(tmpDir, { emitRscPrewarmManifest: true });

    const assetsDir = path.join(tmpDir, "dist/client/_next/static");
    const [firstAsset] = fs.readdirSync(assetsDir);

    writeFile(
      "dist/server/vinext-prerender.json",
      JSON.stringify({
        routes: [
          {
            route: "/second",
            status: "rendered",
            router: "app",
            revalidate: false,
            fallback: false,
          },
        ],
      }),
    );
    injectPregeneratedConcretePaths(tmpDir, { emitRscPrewarmManifest: true });

    const [secondAsset] = fs.readdirSync(assetsDir);
    expect(secondAsset).not.toBe(firstAsset);
    expect(fs.existsSync(path.join(assetsDir, firstAsset))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(assetsDir, secondAsset), "utf-8"))).toEqual({
      version: 1,
      paths: ["/second"],
    });
  });

  it("does not emit RSC eligibility without a final cacheable App result", () => {
    writeFile(
      "dist/server/index.js",
      'export default { fetch() { return new Response("ok"); } };\n',
    );
    writeFile(
      "dist/server/vinext-prerender.json",
      JSON.stringify({
        routes: [
          {
            route: "/dynamic",
            status: "skipped",
            router: "app",
            revalidate: false,
            fallback: false,
          },
        ],
      }),
    );

    injectPregeneratedConcretePaths(tmpDir, { emitRscPrewarmManifest: true });

    expect(fs.existsSync(path.join(tmpDir, "dist/client/_next/static"))).toBe(false);
    const output = fs.readFileSync(path.join(tmpDir, "dist/server/index.js"), "utf-8");
    expect(output).not.toContain("__VINEXT_RSC_PREWARM");
    expect(globalThis.__VINEXT_RSC_PREWARM_MANIFEST_URL).toBeUndefined();
    expect(globalThis.__VINEXT_RSC_PREWARMABLE_PATHS).toBeUndefined();
  });
});
