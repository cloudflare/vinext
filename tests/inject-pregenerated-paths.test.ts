import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
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

  it("derives concrete paths from route entries when the manifest has no pregenerated table", () => {
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
            route: "/blog/:slug",
            status: "rendered",
            router: "app",
            path: "/blog/post-a",
            revalidate: 60,
            fallback: false,
          },
          {
            route: "/blog/:slug",
            status: "rendered",
            router: "app",
            path: "/blog/[slug]",
            revalidate: 60,
            fallback: true,
          },
        ],
      }),
    );

    injectPregeneratedConcretePaths(tmpDir);

    const output = fs.readFileSync(path.join(tmpDir, "dist/server/index.js"), "utf-8");
    const match = output.match(/globalThis\.__VINEXT_PREGENERATED_CONCRETE_PATHS = (\[.*?\]);/);
    expect(match).not.toBeNull();
    expect(JSON.parse(match![1])).toEqual([["/blog/:slug", ["/blog/post-a"]]]);
  });

  it("does not rewrite the server bundle when there is no injection to add or strip", () => {
    const sourceCode = 'export default { fetch() { return new Response("ok"); } };\n';
    writeFile("dist/server/index.js", sourceCode);
    writeFile(
      "dist/server/vinext-prerender.json",
      JSON.stringify({
        buildId: "test",
        routes: [
          {
            route: "/about",
            status: "skipped",
            router: "app",
            reason: "dynamic",
          },
        ],
      }),
    );

    const entryPath = path.join(tmpDir, "dist/server/index.js");
    const beforeMtime = fs.statSync(entryPath).mtimeMs;
    injectPregeneratedConcretePaths(tmpDir);

    expect(fs.readFileSync(entryPath, "utf-8")).toBe(sourceCode);
    expect(fs.statSync(entryPath).mtimeMs).toBe(beforeMtime);
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
});
