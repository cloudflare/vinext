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
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("injectPregeneratedConcretePaths", () => {
  it("replaces an earlier injection", () => {
    writeFile(
      "dist/server/index.js",
      'import { handler } from "vinext/server/app-router-entry";\n',
    );
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
    expect(output).toContain('import { handler } from "vinext/server/app-router-entry"');
  });

  it("strips an earlier injection when the manifest is missing", () => {
    writeFile(
      "dist/server/index.js",
      [
        "/* __VINEXT_PREGENERATED_CONCRETE_PATHS_START__ */",
        'globalThis.__VINEXT_PREGENERATED_CONCRETE_PATHS = [["/blog/:slug",["/blog/post-a"]]];',
        "/* __VINEXT_PREGENERATED_CONCRETE_PATHS_END__ */",
        'import { handler } from "vinext/server/app-router-entry";',
        "",
      ].join("\n"),
    );

    injectPregeneratedConcretePaths(tmpDir);

    const output = fs.readFileSync(path.join(tmpDir, "dist/server/index.js"), "utf-8");
    expect(output).not.toContain("__VINEXT_PREGENERATED_CONCRETE_PATHS");
    expect(output).toContain('import { handler } from "vinext/server/app-router-entry"');
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
