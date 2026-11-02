import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createBuilder, type Plugin } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";
import { CLIENT_COMPILE_HINT } from "../packages/vinext/src/plugins/client-compile-hints.js";

type ViteManifestChunk = { file: string; name?: string; imports?: string[] };

const USER_POST_BANNER = "/* user post banner */";
const HINTS_PLUGIN = "vinext:client-compile-hints";

type ClientBuild = { dir: string; clientDir: string; manifest: Record<string, ViteManifestChunk> };

const FIXTURE_FILES: Record<string, string> = {
  "package.json": `{"type":"module"}`,
  "app/layout.tsx": `export default function Root({ children }: { children: React.ReactNode }) {
  return <html><body>{children}</body></html>;
}
`,
  "app/counter.tsx": `"use client";
import { useState } from "react";
export function Counter() {
  const [count, setCount] = useState(0);
  return <button onClick={() => setCount(count + 1)}>{count}</button>;
}
`,
  "app/page.tsx": `import { Counter } from "./counter";
export default function Page() {
  return <Counter />;
}
`,
  "pages/legacy.tsx": `export default function Legacy() {
  return <p>Pages Router</p>;
}
`,
  // The browser entries import instrumentation-client statically. A user
  // chunk group mixes a module it imports statically with one it imports
  // lazily, so the grouped chunk imports the lazy module's dependency eagerly.
  "instrumentation-client.ts": `import { startupValue } from "./mixed/startup";
(globalThis as Record<string, unknown>).__startupValue = startupValue;
void import("./mixed/lazy");
`,
  "mixed/startup.ts": `export const startupValue = "startup";
`,
  "mixed/lazy.ts": `import { lazyDepValue } from "./lazy-dep";
(globalThis as Record<string, unknown>).__lazyDepValue = lazyDepValue;
`,
  "mixed/lazy-dep.ts": `export const lazyDepValue = "lazy dependency";
`,
};

type BuildOptions = {
  files?: Record<string, string>;
  output?: Record<string, unknown>;
  extraPlugins?: Plugin[];
};

/** Builds a hybrid App + Pages app with client sourcemaps and a user postBanner. */
async function buildClient(
  withHints: boolean,
  { files = FIXTURE_FILES, output = {}, extraPlugins = [] }: BuildOptions = {},
): Promise<ClientBuild> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-client-compile-hints-"));
  for (const [file, source] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), source);
  }
  fs.symlinkSync(
    path.resolve(import.meta.dirname, "../node_modules"),
    path.join(dir, "node_modules"),
    "junction",
  );
  const plugins = vinext({ appDir: dir });
  const filtered = plugins.filter(
    (plugin) =>
      withHints ||
      !(plugin && typeof plugin === "object" && "name" in plugin && plugin.name === HINTS_PLUGIN),
  );
  expect(filtered.length).toBe(withHints ? plugins.length : plugins.length - 1);
  const builder = await createBuilder({
    root: dir,
    configFile: false,
    plugins: [...filtered, ...extraPlugins],
    environments: {
      client: {
        build: {
          sourcemap: true,
          rolldownOptions: {
            output: {
              postBanner: USER_POST_BANNER,
              ...output,
              codeSplitting: {
                groups: [
                  {
                    name: "mixed-startup-lazy",
                    test: /mixed[\\/](startup|lazy)\.ts$/,
                    minSize: 0,
                  },
                  { name: "lazy-dep", test: /mixed[\\/]lazy-dep\.ts$/, priority: 1, minSize: 0 },
                ],
              },
            },
          },
        },
      },
    },
    logLevel: "silent",
  });
  await builder.buildApp();
  const clientDir = path.join(dir, "dist", "client");
  const manifest = JSON.parse(
    fs.readFileSync(path.join(clientDir, ".vite", "manifest.json"), "utf8"),
  ) as Record<string, ViteManifestChunk>;
  return { dir, clientDir, manifest };
}

describe("client compile hints", () => {
  let hinted: ClientBuild;
  let plain: ClientBuild;
  let clientDir = "";
  let manifest: Record<string, ViteManifestChunk> = {};
  const extraBuilds: ClientBuild[] = [];

  beforeAll(async () => {
    hinted = await buildClient(true);
    plain = await buildClient(false);
    ({ clientDir, manifest } = hinted);
  }, 120000);

  afterAll(() => {
    for (const build of [hinted, plain, ...extraBuilds]) {
      if (build) fs.rmSync(build.dir, { recursive: true, force: true });
    }
  });

  const read = (file: string) => fs.readFileSync(path.join(clientDir, file), "utf8");

  /** The build manifest key of a module; virtual ids are keyed by a path ending in the id. */
  function keyOf(id: string): string {
    const key = Object.keys(manifest).find((candidate) => candidate.endsWith(id));
    expect(key).toBeDefined();
    return key!;
  }

  /** Manifest keys of the browser entries and everything they import statically. */
  function startupKeys(): Set<string> {
    const entries = ["virtual:vinext-app-browser-entry", "virtual:vinext-client-entry"].map(keyOf);
    const keys = new Set<string>();
    const visit = (key: string) => {
      if (keys.has(key)) return;
      keys.add(key);
      for (const imported of manifest[key]?.imports ?? []) visit(imported);
    };
    for (const entry of entries) visit(entry);
    return keys;
  }

  it("marks the chunks the browser entries import statically", () => {
    const startup = [...startupKeys()].map((key) => read(manifest[key]!.file));
    // The entries share React, React DOM and the vinext runtime.
    expect(startup.length).toBeGreaterThan(2);
    // Vite prepends its preload helper to chunks with dynamic imports after
    // minification; the hint still has to come first.
    expect(startup.some((code) => code.includes("const __vite__mapDeps="))).toBe(true);
    for (const code of startup) {
      expect(code.startsWith(`${CLIENT_COMPILE_HINT}\n`)).toBe(true);
      expect(code.split(CLIENT_COMPILE_HINT)).toHaveLength(2);
      expect(code).toContain(USER_POST_BANNER);
    }
  });

  it("leaves chunks loaded through dynamic imports to lazy compilation", () => {
    const startup = startupKeys();
    const lazy = Object.entries(manifest).filter(
      ([key, chunk]) => !startup.has(key) && chunk.file.endsWith(".js"),
    );
    // The Pages route, the App client reference and the route manifest.
    expect(lazy.map(([key]) => key)).toEqual(
      expect.arrayContaining([
        keyOf("pages/legacy.tsx"),
        keyOf("/counter"),
        keyOf("virtual:vinext-app-route-manifest"),
      ]),
    );
    for (const [, chunk] of lazy) {
      const code = read(chunk.file);
      expect(code).toContain(USER_POST_BANNER);
      expect(code).not.toContain(CLIENT_COMPILE_HINT);
    }
  });

  it("shifts the sourcemaps of marked chunks by the hint line", () => {
    const mapped = [...startupKeys()]
      .map((key) => manifest[key]!.file)
      // Rolldown's runtime helpers have no sources, so no sourcemap.
      .filter((file) => fs.existsSync(path.join(clientDir, `${file}.map`)));
    expect(mapped).toContain(manifest[keyOf("virtual:vinext-app-browser-entry")]!.file);
    for (const file of mapped) {
      const lines = read(file).split("\n");
      // The hint, Vite's preload helper and the user banner carry no mappings.
      const firstCodeLine = lines.findIndex(
        (line) =>
          line !== CLIENT_COMPILE_HINT &&
          line !== USER_POST_BANNER &&
          !line.startsWith("const __vite__mapDeps="),
      );
      expect(firstCodeLine).toBeGreaterThan(1);
      const map = JSON.parse(read(`${file}.map`)) as { mappings: string };
      expect(map.mappings.match(/^;*/)![0]).toHaveLength(firstCodeLine);
    }
  });

  it("marks a chunk that a mixed chunk group imports eagerly", () => {
    const keyNamed = (name: string) => {
      const key = Object.keys(manifest).find((candidate) => manifest[candidate]!.name === name);
      expect(key).toBeDefined();
      return key!;
    };
    const mixed = keyNamed("mixed-startup-lazy");
    const lazyDep = keyNamed("lazy-dep");
    // Only a lazily imported module needs lazy-dep, but the grouped chunk
    // imports it statically, so every page load runs it.
    expect(startupKeys().has(mixed)).toBe(true);
    expect(manifest[mixed]!.imports).toContain(lazyDep);
    expect(read(manifest[lazyDep]!.file).startsWith(`${CLIENT_COMPILE_HINT}\n`)).toBe(true);
  });

  it("gives marked chunks new hashes, since the hint lands after hashing", () => {
    const fileOf = (build: ClientBuild, id: string) =>
      build.manifest[Object.keys(build.manifest).find((key) => key.endsWith(id))!]!.file;
    const entry = "virtual:vinext-app-browser-entry";
    // Browsers may hold a hashed file as immutable, so a hinted file must not
    // reuse the URL its unhinted bytes had.
    expect(fileOf(hinted, entry)).not.toBe(fileOf(plain, entry));
    // Apart from the hint, the bytes differ only where they name hashed chunks.
    const unhashed = (build: ClientBuild, file: string) =>
      fs
        .readFileSync(path.join(build.clientDir, file), "utf8")
        .replace(/[\w-]{8}\.js/g, "[hash].js");
    expect(unhashed(hinted, fileOf(hinted, entry))).toBe(
      `${CLIENT_COMPILE_HINT}\n${unhashed(plain, fileOf(plain, entry))}`,
    );
    // A chunk outside the startup graph that imports nothing keeps its name.
    const routeManifest = "virtual:vinext-app-route-manifest";
    expect(fileOf(hinted, routeManifest)).toBe(fileOf(plain, routeManifest));
  });

  /** Builds with extra output options and checks that no chunk got the hint. */
  async function expectUnmarked(minChunks: number, options: BuildOptions) {
    const build = await buildClient(true, options);
    extraBuilds.push(build);
    const files = [...new Set(Object.values(build.manifest).map((chunk) => chunk.file))].filter(
      (file) => file.endsWith(".js"),
    );
    expect(files.length).toBeGreaterThanOrEqual(minChunks);
    const sources = files.map((file) => fs.readFileSync(path.join(build.clientDir, file), "utf8"));
    for (const code of sources) expect(code).not.toContain(CLIENT_COMPILE_HINT);
    return sources;
  }

  it("leaves builds that name their sourcemaps themselves unmarked", async () => {
    // The map's own hash would not cover the shifted mappings.
    await expectUnmarked(3, { output: { sourcemapFileNames: "maps/[name]-[hash].js.map" } });
  }, 60000);

  it("leaves builds without code splitting unmarked", async () => {
    // The Pages Router entry inlines the pages it imports lazily. Rolldown
    // allows that for a single input only, and vinext's own codeSplitting
    // config would replace a user `false`, so a later plugin turns it off.
    const noCodeSplitting: Plugin = {
      name: "test:no-code-splitting",
      enforce: "post",
      configEnvironment(name, config) {
        const output = config.build?.rolldownOptions?.output;
        if (name === "client" && output && !Array.isArray(output)) output.codeSplitting = false;
      },
    };
    const pagesOnly = Object.fromEntries(
      Object.entries(FIXTURE_FILES).filter(([file]) => !file.startsWith("app/")),
    );
    const sources = await expectUnmarked(1, { files: pagesOnly, extraPlugins: [noCodeSplitting] });
    expect(sources.some((code) => code.includes("Pages Router"))).toBe(true);
  }, 60000);
});
