import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { injectPregeneratedConcretePaths } from "../packages/vinext/src/build/inject-pregenerated-paths.js";
import {
  clearPregeneratedConcretePaths,
  PREGENERATED_CONCRETE_PATHS_MODULE,
} from "../packages/vinext/src/server/pregenerated-concrete-paths.js";

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
  it("updates the sidecar without rewriting the built entry or its sourcemap", () => {
    const entry = 'import { handler } from "vinext/server/fetch-handler";\n';
    const sourceMap = '{"version":3,"sources":["entry.ts"]}\n';
    writeFile("dist/server/index-a1b2.js", entry);
    writeFile("dist/server/index-a1b2.js.map", sourceMap);
    writeFile(
      "dist/server/vinext-prerender.json",
      JSON.stringify({
        buildId: "build-a",
        pregeneratedConcretePaths: [["/blog/:slug", ["/blog/post-a"]]],
      }),
    );
    const entryPath = path.join(tmpDir, "dist/server/index-a1b2.js");
    injectPregeneratedConcretePaths(tmpDir, entryPath);

    writeFile(
      "dist/server/vinext-prerender.json",
      JSON.stringify({
        buildId: "build-b",
        pregeneratedConcretePaths: [["/blog/:slug", ["/blog/post-b"]]],
      }),
    );
    injectPregeneratedConcretePaths(tmpDir, entryPath);

    const runtimeTable = fs.readFileSync(
      path.join(tmpDir, "dist/server", PREGENERATED_CONCRETE_PATHS_MODULE),
      "utf-8",
    );
    expect(runtimeTable).toContain("post-b");
    expect(runtimeTable).not.toContain("post-a");
    expect(fs.readFileSync(entryPath, "utf-8")).toBe(entry);
    expect(fs.readFileSync(`${entryPath}.map`, "utf-8")).toBe(sourceMap);
  });

  it("clears the sidecar when the manifest is missing", () => {
    const entry = 'import { handler } from "vinext/server/fetch-handler";\n';
    writeFile("dist/server/index.js", entry);

    injectPregeneratedConcretePaths(tmpDir);

    expect(
      fs.readFileSync(
        path.join(tmpDir, "dist/server", PREGENERATED_CONCRETE_PATHS_MODULE),
        "utf-8",
      ),
    ).toBe("delete globalThis.__VINEXT_PREGENERATED_CONCRETE_PATHS;\n");
    expect(fs.readFileSync(path.join(tmpDir, "dist/server/index.js"), "utf-8")).toBe(entry);
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

    const output = fs.readFileSync(
      path.join(tmpDir, "dist/server", PREGENERATED_CONCRETE_PATHS_MODULE),
      "utf-8",
    );
    const match = output.match(/globalThis\.__VINEXT_PREGENERATED_CONCRETE_PATHS = (\[.*?\]);/);
    expect(match).not.toBeNull();
    expect(JSON.parse(match![1])).toEqual([["/blog/:slug", ["/blog/post-a"]]]);
    expect(globalThis.__VINEXT_PREGENERATED_CONCRETE_PATHS).toEqual([
      ["/blog/:slug", ["/blog/post-a"]],
    ]);
  });

  it("clears the current-process global when no concrete paths are available", () => {
    globalThis.__VINEXT_PREGENERATED_CONCRETE_PATHS = [["/old/:slug", ["/old/post"]]];

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
        `import "./${PREGENERATED_CONCRETE_PATHS_MODULE}";`,
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

  it("hydrates an independently deployed response-stage entry", async () => {
    const registryModuleUrl = pathToFileURL(
      path.resolve("packages/vinext/src/server/pregenerated-concrete-paths.ts"),
    ).href;
    writeFile("dist/server/index.js", "export default { fetch() {} };\n");
    writeFile(
      "dist/server/vinext-response-stage.js",
      [
        `import "./${PREGENERATED_CONCRETE_PATHS_MODULE}";`,
        `import { getRenderedConcreteUrlPathsForRoute, initPregeneratedPathsFromGlobals } from ${JSON.stringify(registryModuleUrl)};`,
        "initPregeneratedPathsFromGlobals();",
        'export const renderedPaths = [...(getRenderedConcreteUrlPathsForRoute("/blog/:slug") ?? [])];',
        "export default { fetch() {} };",
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

    const entryUrl = pathToFileURL(path.join(tmpDir, "dist/server/vinext-response-stage.js")).href;
    const responseEntry: unknown = await import(`${entryUrl}?t=${Date.now()}`);
    expect(responseEntry).toMatchObject({ renderedPaths: ["/blog/post-a"] });
  });

  it("writes the runtime table beside a custom application entry", async () => {
    const registryModuleUrl = pathToFileURL(
      path.resolve("packages/vinext/src/server/pregenerated-concrete-paths.ts"),
    ).href;
    const rscServerDir = path.join(tmpDir, "dist/custom-rsc");
    const entryPath = path.join(rscServerDir, "entries/application-entry.js");
    writeFile(
      "dist/custom-rsc/entries/application-entry.js",
      [
        `import "./${PREGENERATED_CONCRETE_PATHS_MODULE}";`,
        `import { getRenderedConcreteUrlPathsForRoute, initPregeneratedPathsFromGlobals } from ${JSON.stringify(registryModuleUrl)};`,
        "initPregeneratedPathsFromGlobals();",
        'export const renderedPaths = [...(getRenderedConcreteUrlPathsForRoute("/blog/:slug") ?? [])];',
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

    injectPregeneratedConcretePaths(tmpDir, entryPath, path.join(tmpDir, "dist/server"), [
      rscServerDir,
    ]);

    expect(
      fs.existsSync(path.join(path.dirname(entryPath), PREGENERATED_CONCRETE_PATHS_MODULE)),
    ).toBe(true);
    expect(
      fs.readFileSync(
        path.join(tmpDir, "dist/server", PREGENERATED_CONCRETE_PATHS_MODULE),
        "utf-8",
      ),
    ).toContain("/blog/post-a");
    expect(
      fs.readFileSync(path.join(rscServerDir, PREGENERATED_CONCRETE_PATHS_MODULE), "utf-8"),
    ).toContain("/blog/post-a");
    const applicationEntry: unknown = await import(
      `${pathToFileURL(entryPath).href}?t=${Date.now()}`
    );
    expect(applicationEntry).toMatchObject({ renderedPaths: ["/blog/post-a"] });
  });

  it("clears the sidecar without rewriting the entry when the manifest is corrupt", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const entry = 'export default { fetch() { return new Response("ok"); } };\n';
    writeFile("dist/server/index.js", entry);
    writeFile("dist/server/vinext-prerender.json", "{invalid json}");

    injectPregeneratedConcretePaths(tmpDir);

    expect(
      fs.readFileSync(
        path.join(tmpDir, "dist/server", PREGENERATED_CONCRETE_PATHS_MODULE),
        "utf-8",
      ),
    ).toBe("delete globalThis.__VINEXT_PREGENERATED_CONCRETE_PATHS;\n");
    expect(fs.readFileSync(path.join(tmpDir, "dist/server/index.js"), "utf-8")).toBe(entry);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[vinext] Failed to read prerender manifest"),
      expect.any(SyntaxError),
    );
  });
});
