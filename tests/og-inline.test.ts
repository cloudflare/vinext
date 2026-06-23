import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";
import { build, type Plugin } from "vite-plus";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// ── Helpers ───────────────────────────────────────────────────

/** Unwrap a Vite plugin hook that may use the object-with-filter format */
function unwrapHook(hook: any): Function {
  return typeof hook === "function" ? hook : hook?.handler;
}

/**
 * Create a fresh vinext:og-inline-fetch-assets plugin instance.
 * Each call gets an independent cache so tests do not share state.
 */
function createOgInlinePlugin(command: "serve" | "build" = "serve", root = tmpDir): Plugin {
  const plugins = vinext() as Plugin[];
  const plugin = plugins.find((p) => p.name === "vinext:og-inline-fetch-assets");
  if (!plugin) throw new Error("vinext:og-inline-fetch-assets plugin not found");
  const configResolved = unwrapHook(plugin.configResolved);
  configResolved?.call(plugin, { command, root, resolve: { alias: [] } });
  return plugin;
}

async function resolveLinkedPackage(
  plugin: Plugin,
  root: string,
  source: string,
  resolvedId: string,
  find: string | RegExp = source,
) {
  const configResolved = unwrapHook(plugin.configResolved);
  configResolved.call(plugin, {
    command: "build",
    root,
    resolve: { alias: [{ find, replacement: resolvedId }] },
  });
  const resolveId = unwrapHook(plugin.resolveId);
  await resolveId.call(
    {
      resolve: async () => ({ id: resolvedId }),
    },
    source,
    path.join(tmpDir, "app.ts"),
    {},
  );
}

// ── Test fixture setup ────────────────────────────────────────

let tmpDir: string;
const fontContent = Buffer.from("fake-font-data-for-testing");
const fontBase64 = fontContent.toString("base64");

beforeAll(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "og-inline-test-"));
  await fsp.writeFile(path.join(tmpDir, "noto-sans.ttf"), fontContent);
});

afterAll(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

// ── Tests ─────────────────────────────────────────────────────

describe("vinext:og-inline-fetch-assets plugin", () => {
  afterEach(() => vi.restoreAllMocks());

  it("exists in the plugin array", () => {
    const plugin = createOgInlinePlugin();
    expect(plugin.name).toBe("vinext:og-inline-fetch-assets");
    expect(plugin.enforce).toBe("pre");
  });

  // ── Guard clause ──────────────────────────────────────────

  it("returns null when code has no import.meta.url", async () => {
    const plugin = createOgInlinePlugin();
    const transform = unwrapHook(plugin.transform);
    const code = `import fs from 'node:fs';\nconst x = 1;`;
    const result = await transform.call(plugin, code, "/app/og.tsx");
    expect(result).toBeNull();
  });

  // ── Pattern 1: fetch ─────────────────────────────────────

  it("transforms fetch(new URL(..., import.meta.url)).then(r => r.arrayBuffer())", async () => {
    const plugin = createOgInlinePlugin();
    const transform = unwrapHook(plugin.transform);
    const code = `const data = fetch(new URL("./noto-sans.ttf", import.meta.url)).then((res) => res.arrayBuffer());`;
    const moduleId = path.join(tmpDir, "og.tsx");

    const result = await transform.call(plugin, code, moduleId);
    expect(result).not.toBeNull();
    // The font's base64 contents must be inlined and the runtime fetch eliminated.
    expect(result.code).toContain(fontBase64);
    expect(result.code).not.toContain("fetch(");
  });

  it("transforms fetch(new URL(..., import.meta.url)) with ../-relative path", async () => {
    // Fixtures like og-routes-custom-font and metadata-font use paths such as
    // "../../../assets/typewr__.ttf" (three levels up from the route file to
    // the project-root assets/ directory). The plugin must resolve these just
    // as it does ./-relative paths.
    const plugin = createOgInlinePlugin();
    const transform = unwrapHook(plugin.transform);
    // Module lives at tmpDir/app/app/og/route.tsx → font is three levels up
    const routeDir = path.join(tmpDir, "app", "app", "og");
    await fsp.mkdir(routeDir, { recursive: true });
    const code = `const data = fetch(new URL("../../../noto-sans.ttf", import.meta.url)).then((res) => res.arrayBuffer());`;
    const moduleId = path.join(routeDir, "route.tsx");

    const result = await transform.call(plugin, code, moduleId);
    expect(result).not.toBeNull();
    expect(result.code).toContain(fontBase64);
    expect(result.code).not.toContain("fetch(");
  });

  it("transforms fetch().then() that a formatter wrapped across lines with a trailing comma", async () => {
    // Real-world regression: formatters (Prettier `trailingComma: "all"`, oxfmt)
    // wrap a long fetch().then() across multiple lines and add a trailing comma:
    //   const font = await fetch(new URL("../../../assets/noto-sans.ttf", import.meta.url)).then(
    //     (res) => res.arrayBuffer(),
    //   );
    // The earlier regex only matched the single-line, comma-less form, so formatted
    // source was left as a runtime fetch — which throws "Invalid URL" on Workers
    // (import.meta.url === "worker") and returns a 500. See the /api/og-custom-font
    // e2e in tests/e2e/og-image.spec.ts.
    const plugin = createOgInlinePlugin();
    const transform = unwrapHook(plugin.transform);
    const code = [
      `const font = await fetch(new URL("./noto-sans.ttf", import.meta.url)).then((res) =>`,
      `  res.arrayBuffer(),`,
      `);`,
    ].join("\n");
    const moduleId = path.join(tmpDir, "og.tsx");

    const result = await transform.call(plugin, code, moduleId);
    expect(result).not.toBeNull();
    expect(result.code).toContain(fontBase64);
    expect(result.code).not.toContain("fetch(");
  });

  it("transforms a block-body .then() callback whose return ends with a semicolon", async () => {
    // Formatters terminate a block-body `return` with a semicolon:
    //   .then((res) => {
    //     return res.arrayBuffer();
    //   })
    // The block-body alternative must tolerate the `;` before `}` (and a trailing
    // comma). Without `;?` this stayed a runtime fetch → "Invalid URL" on Workers.
    const plugin = createOgInlinePlugin();
    const transform = unwrapHook(plugin.transform);
    const code = [
      `const font = await fetch(new URL("./noto-sans.ttf", import.meta.url)).then((res) => {`,
      `  return res.arrayBuffer();`,
      `});`,
    ].join("\n");
    const moduleId = path.join(tmpDir, "og.tsx");

    const result = await transform.call(plugin, code, moduleId);
    expect(result).not.toBeNull();
    expect(result.code).toContain(fontBase64);
    expect(result.code).not.toContain("fetch(");
  });

  it("transforms a function-expression .then() callback whose return ends with a semicolon", async () => {
    // Same as above but with a `function (res) { ... }` callback instead of an arrow.
    const plugin = createOgInlinePlugin();
    const transform = unwrapHook(plugin.transform);
    const code = `const font = await fetch(new URL("./noto-sans.ttf", import.meta.url)).then(function (res) { return res.arrayBuffer(); });`;
    const moduleId = path.join(tmpDir, "og.tsx");

    const result = await transform.call(plugin, code, moduleId);
    expect(result).not.toBeNull();
    expect(result.code).toContain(fontBase64);
    expect(result.code).not.toContain("fetch(");
  });

  // ── Pattern 2: readFileSync ──────────────────────────────

  it("transforms fs.readFileSync(fileURLToPath(new URL(..., import.meta.url)))", async () => {
    const plugin = createOgInlinePlugin();
    const transform = unwrapHook(plugin.transform);
    const code = `const buf = fs.readFileSync(fileURLToPath(new URL("./noto-sans.ttf", import.meta.url)));`;
    const moduleId = path.join(tmpDir, "og.tsx");

    const result = await transform.call(plugin, code, moduleId);
    expect(result).not.toBeNull();
    // Font contents inlined as base64 and the runtime fs read eliminated.
    expect(result.code).toContain(fontBase64);
    expect(result.code).not.toContain("readFileSync");
  });

  it("transforms fs.readFileSync(fileURLToPath(new URL(..., import.meta.url))) with ../-relative path", async () => {
    // Same pattern as above but with a ../ path traversal — mirrors metadata-font fixtures.
    const plugin = createOgInlinePlugin();
    const transform = unwrapHook(plugin.transform);
    const routeDir = path.join(tmpDir, "app", "font");
    await fsp.mkdir(routeDir, { recursive: true });
    const code = `const buf = fs.readFileSync(fileURLToPath(new URL("../../noto-sans.ttf", import.meta.url)));`;
    const moduleId = path.join(routeDir, "opengraph-image.tsx");

    const result = await transform.call(plugin, code, moduleId);
    expect(result).not.toBeNull();
    expect(result.code).toContain(fontBase64);
    expect(result.code).not.toContain("readFileSync");
  });

  // ── Asset boundaries ───────────────────────────────────────

  it("inlines assets contained within a dependency package", async () => {
    const projectRoot = path.join(tmpDir, "dependency-asset");
    const packageDir = path.join(tmpDir, "node_modules", "og-helper");
    const packageFont = Buffer.from("dependency-font");
    await fsp.mkdir(projectRoot, { recursive: true });
    await fsp.mkdir(packageDir, { recursive: true });
    await fsp.writeFile(path.join(packageDir, "package.json"), '{"name":"og-helper"}');
    await fsp.writeFile(path.join(packageDir, "font.ttf"), packageFont);

    const plugin = createOgInlinePlugin("build", projectRoot);
    const transform = unwrapHook(plugin.transform);
    const code = `const data = fetch(new URL("./font.ttf", import.meta.url)).then((res) => res.arrayBuffer());`;
    const result = await transform.call(plugin, code, path.join(packageDir, "index.js"));

    expect(result?.code).toContain(packageFont.toString("base64"));
  });

  // A scoped package name is always forward-slash (`@scope/og-helper`), even on
  // Windows — it is an npm specifier, not a filesystem path, so it must not go
  // through `path.join` (which would yield `@scope\og-helper`). `path.join`
  // below still turns it into the right nested directory on disk.
  it.each(["og-helper", "@scope/og-helper"])(
    "inlines assets contained within a linked workspace package (%s)",
    async (packageName) => {
      const projectRoot = path.join(tmpDir, "linked-workspace", "app");
      const packageDir = path.join(tmpDir, "linked-workspace", "packages", packageName);
      const packageFont = Buffer.from(`linked-${packageName}-font`);
      await fsp.mkdir(projectRoot, { recursive: true });
      await fsp.mkdir(packageDir, { recursive: true });
      await fsp.writeFile(
        path.join(packageDir, "package.json"),
        JSON.stringify({ name: packageName }),
      );
      await fsp.writeFile(path.join(packageDir, "index.js"), "export {};");
      await fsp.writeFile(path.join(packageDir, "font.ttf"), packageFont);

      const plugin = createOgInlinePlugin("build", projectRoot);
      await resolveLinkedPackage(
        plugin,
        projectRoot,
        packageName,
        path.join(packageDir, "index.js"),
      );
      const transform = unwrapHook(plugin.transform);
      const code = `const data = fetch(new URL("./font.ttf", import.meta.url)).then((res) => res.arrayBuffer());`;
      const result = await transform.call(plugin, code, path.join(packageDir, "index.js"));

      expect(result?.code).toContain(packageFont.toString("base64"));
    },
  );

  it.each([
    ["scoped", "ui", "@scope/ui"],
    ["renamed", "design-system", "ui"],
  ])(
    "inlines assets in a %s linked package with a differing directory name",
    async (_, dir, name) => {
      const workspaceRoot = path.join(tmpDir, `linked-workspace-${dir}`);
      const projectRoot = path.join(workspaceRoot, "app");
      const packageDir = path.join(workspaceRoot, "packages", dir);
      const packageFont = Buffer.from(`linked-${name}-font`);
      await fsp.mkdir(projectRoot, { recursive: true });
      await fsp.mkdir(packageDir, { recursive: true });
      await fsp.writeFile(
        path.join(packageDir, "package.json"),
        JSON.stringify({ name, main: "index.js" }),
      );
      await fsp.writeFile(path.join(packageDir, "index.js"), "export {};");
      await fsp.writeFile(path.join(packageDir, "font.ttf"), packageFont);

      const plugin = createOgInlinePlugin("build", projectRoot);
      await resolveLinkedPackage(plugin, projectRoot, name, path.join(packageDir, "index.js"));
      const transform = unwrapHook(plugin.transform);
      const code = `const data = fetch(new URL("./font.ttf", import.meta.url)).then((res) => res.arrayBuffer());`;
      const result = await transform.call(plugin, code, path.join(packageDir, "index.js"));

      expect(result?.code).toContain(packageFont.toString("base64"));
    },
  );

  it("inlines assets for a deep module in a renamed linked package", async () => {
    const workspaceRoot = path.join(tmpDir, "linked-workspace-deep-renamed");
    const projectRoot = path.join(workspaceRoot, "app");
    const packageDir = path.join(workspaceRoot, "packages", "design-system");
    const modulePath = path.join(packageDir, "dist", "chunk-abc.js");
    const packageFont = Buffer.from("linked-deep-renamed-font");
    await fsp.mkdir(projectRoot, { recursive: true });
    await fsp.mkdir(path.dirname(modulePath), { recursive: true });
    await fsp.writeFile(
      path.join(packageDir, "package.json"),
      JSON.stringify({ name: "ui", main: "dist/index.js" }),
    );
    await fsp.writeFile(modulePath, "export {};");
    await fsp.writeFile(path.join(packageDir, "dist", "font.ttf"), packageFont);

    const plugin = createOgInlinePlugin("build", projectRoot);
    await resolveLinkedPackage(plugin, projectRoot, "ui", modulePath);
    const transform = unwrapHook(plugin.transform);
    const code = `const data = fetch(new URL("./font.ttf", import.meta.url)).then((res) => res.arrayBuffer());`;
    const result = await transform.call(plugin, code, modulePath);

    expect(result?.code).toContain(packageFont.toString("base64"));
  });

  it("inlines a linked package asset through a real Vite build", async () => {
    const workspaceRoot = path.join(tmpDir, "linked-workspace-build");
    const projectRoot = path.join(workspaceRoot, "app");
    const packageDir = path.join(workspaceRoot, "packages", "design-system");
    const packageFont = Buffer.alloc(20_000, "linked-build-font");
    await fsp.mkdir(projectRoot, { recursive: true });
    await fsp.mkdir(path.join(packageDir, "dist"), { recursive: true });
    await fsp.writeFile(path.join(projectRoot, "package.json"), '{"dependencies":{"ui":"*"}}');
    await fsp.writeFile(path.join(projectRoot, "index.js"), 'import "ui";');
    await fsp.writeFile(
      path.join(packageDir, "package.json"),
      '{"name":"@scope/design-system","main":"dist/index.js"}',
    );
    await fsp.writeFile(
      path.join(packageDir, "dist", "index.js"),
      'export const data = fetch(new URL("./font.ttf", import.meta.url)).then((res) => res.arrayBuffer());',
    );
    await fsp.writeFile(path.join(packageDir, "dist", "font.ttf"), packageFont);

    await build({
      root: projectRoot,
      logLevel: "silent",
      resolve: { alias: { ui: path.join(packageDir, "dist", "index.js") } },
      plugins: [createOgInlinePlugin("build", projectRoot)],
      build: {
        outDir: "dist",
        rollupOptions: {
          input: path.join(projectRoot, "index.js"),
          output: { entryFileNames: "bundle.js" },
        },
      },
    });
    const code = await fsp.readFile(path.join(projectRoot, "dist", "bundle.js"), "utf8");

    expect(code).toContain("atob(");
    expect(code).toContain(packageFont.toString("base64"));
    expect(code).not.toContain("/assets/font-");
  });

  it("uses a directory alias root for subpath imports in a real Vite build", async () => {
    const workspaceRoot = path.join(tmpDir, "linked-directory-alias-build");
    const projectRoot = path.join(workspaceRoot, "app");
    const packageDir = path.join(workspaceRoot, "packages", "design-system");
    const packageFont = Buffer.alloc(20_000, "linked-directory-alias-font");
    await fsp.mkdir(projectRoot, { recursive: true });
    await fsp.mkdir(path.join(packageDir, "dist"), { recursive: true });
    await fsp.writeFile(path.join(projectRoot, "package.json"), "{}");
    await fsp.writeFile(path.join(projectRoot, "index.js"), 'import "ui/dist/chunk.js";');
    await fsp.writeFile(path.join(packageDir, "package.json"), '{"name":"@scope/design-system"}');
    await fsp.writeFile(
      path.join(packageDir, "dist", "chunk.js"),
      'export const data = fetch(new URL("../font.ttf", import.meta.url)).then((res) => res.arrayBuffer());',
    );
    await fsp.writeFile(path.join(packageDir, "font.ttf"), packageFont);

    await build({
      root: projectRoot,
      logLevel: "silent",
      resolve: { alias: { ui: packageDir } },
      plugins: [createOgInlinePlugin("build", projectRoot)],
      build: {
        outDir: "dist",
        rollupOptions: {
          input: path.join(projectRoot, "index.js"),
          output: { entryFileNames: "bundle.js" },
        },
      },
    });
    const code = await fsp.readFile(path.join(projectRoot, "dist", "bundle.js"), "utf8");

    expect(code).toContain("atob(");
    expect(code).toContain(packageFont.toString("base64"));
    expect(code).not.toContain("/assets/font-");
  });

  it("inlines a scoped package through a regex capture alias in a real Vite build", async () => {
    const workspaceRoot = path.join(tmpDir, "regex-capture-alias-build");
    const projectRoot = path.join(workspaceRoot, "app");
    const packagesRoot = path.join(workspaceRoot, "packages");
    const packageDir = path.join(packagesRoot, "ui");
    const packageFont = Buffer.alloc(20_000, "regex-capture-build-font");
    await fsp.mkdir(projectRoot, { recursive: true });
    await fsp.mkdir(path.join(packageDir, "lib"), { recursive: true });
    await fsp.writeFile(path.join(projectRoot, "package.json"), "{}");
    await fsp.writeFile(path.join(projectRoot, "index.js"), 'import "@scope/ui";');
    await fsp.writeFile(
      path.join(packageDir, "package.json"),
      '{"name":"@scope/ui","main":"lib/index.js"}',
    );
    await fsp.writeFile(
      path.join(packageDir, "lib", "index.js"),
      'export const data = fetch(new URL("./font.ttf", import.meta.url)).then((res) => res.arrayBuffer());',
    );
    await fsp.writeFile(path.join(packageDir, "lib", "font.ttf"), packageFont);

    await build({
      root: projectRoot,
      logLevel: "silent",
      resolve: {
        alias: [{ find: /^@scope\/(.*)$/, replacement: `${packagesRoot}/$1/lib/index.js` }],
      },
      plugins: [createOgInlinePlugin("build", projectRoot)],
      build: {
        outDir: "dist",
        rollupOptions: {
          input: path.join(projectRoot, "index.js"),
          output: { entryFileNames: "bundle.js" },
        },
      },
    });
    const code = await fsp.readFile(path.join(projectRoot, "dist", "bundle.js"), "utf8");

    expect(code).toContain("atob(");
    expect(code).toContain(packageFont.toString("base64"));
    expect(code).not.toContain("/assets/font-");
  });

  it("tracks a linked package through a regular-expression alias", async () => {
    const projectRoot = path.join(tmpDir, "regex-alias-app");
    const packageDir = path.join(tmpDir, "regex-alias-package");
    const modulePath = path.join(packageDir, "index.js");
    const packageFont = Buffer.from("regex-alias-font");
    await fsp.mkdir(projectRoot, { recursive: true });
    await fsp.mkdir(packageDir, { recursive: true });
    await fsp.writeFile(path.join(packageDir, "package.json"), '{"name":"ui"}');
    await fsp.writeFile(modulePath, "export {};");
    await fsp.writeFile(path.join(packageDir, "font.ttf"), packageFont);

    const plugin = createOgInlinePlugin("build", projectRoot);
    await resolveLinkedPackage(plugin, projectRoot, "ui/theme", modulePath, /^ui\/theme$/);
    const transform = unwrapHook(plugin.transform);
    const code = `const data = fetch(new URL("./font.ttf", import.meta.url)).then((res) => res.arrayBuffer());`;
    const result = await transform.call(plugin, code, modulePath);

    expect(result?.code).toContain(packageFont.toString("base64"));
  });

  it("tracks a linked package through a regular-expression alias capture", async () => {
    const projectRoot = path.join(tmpDir, "regex-capture-alias-app");
    const packageDir = path.join(tmpDir, "regex-capture-alias-package");
    const modulePath = path.join(packageDir, "dist", "theme.js");
    const packageFont = Buffer.from("regex-capture-alias-font");
    await fsp.mkdir(projectRoot, { recursive: true });
    await fsp.mkdir(path.dirname(modulePath), { recursive: true });
    await fsp.writeFile(
      path.join(packageDir, "package.json"),
      '{"name":"design-system","main":"dist/theme.js"}',
    );
    await fsp.writeFile(modulePath, "export {};");
    await fsp.writeFile(path.join(packageDir, "font.ttf"), packageFont);

    const plugin = createOgInlinePlugin("build", projectRoot);
    const configResolved = unwrapHook(plugin.configResolved);
    configResolved.call(plugin, {
      command: "build",
      root: projectRoot,
      resolve: { alias: [{ find: /^ui\/(.*)$/, replacement: `${packageDir}/$1` }] },
    });
    const resolveId = unwrapHook(plugin.resolveId);
    await resolveId.call(
      { resolve: async () => ({ id: modulePath }) },
      "ui/dist/theme.js",
      path.join(projectRoot, "app.js"),
      {},
    );
    const transform = unwrapHook(plugin.transform);
    const code = `const data = fetch(new URL("../font.ttf", import.meta.url)).then((res) => res.arrayBuffer());`;
    const result = await transform.call(plugin, code, modulePath);

    expect(result?.code).toContain(packageFont.toString("base64"));
  });

  it("does not broaden an embedded regular-expression alias capture to sibling directories", async () => {
    const projectRoot = path.join(tmpDir, "regex-embedded-alias-app");
    const packagesDir = path.join(tmpDir, "regex-embedded-packages");
    const packageDir = path.join(packagesDir, "theme-dark");
    const modulePath = path.join(packageDir, "index.js");
    await fsp.mkdir(projectRoot, { recursive: true });
    await fsp.mkdir(packageDir, { recursive: true });
    await fsp.writeFile(modulePath, "export {};");
    await fsp.writeFile(path.join(packagesDir, "secret.txt"), "embedded-capture-secret");

    const plugin = createOgInlinePlugin("build", projectRoot);
    const configResolved = unwrapHook(plugin.configResolved);
    configResolved.call(plugin, {
      command: "build",
      root: projectRoot,
      resolve: {
        alias: [{ find: /^theme-(.*)$/, replacement: `${packagesDir}/theme-$1/index.js` }],
      },
    });
    const resolveId = unwrapHook(plugin.resolveId);
    await resolveId.call(
      { resolve: async () => ({ id: modulePath }) },
      "theme-dark",
      path.join(projectRoot, "app.js"),
      {},
    );
    const transform = unwrapHook(plugin.transform);
    const code = `const data = fetch(new URL("../secret.txt", import.meta.url)).then((res) => res.arrayBuffer());`;
    const result = await transform.call(plugin, code, modulePath);

    expect(result).toBeNull();
  });

  it("confines a separator-terminated regular-expression capture to the resolved package", async () => {
    const projectRoot = path.join(tmpDir, "regex-package-alias-app");
    const packagesDir = path.join(tmpDir, "regex-package-alias-packages");
    const packageDir = path.join(packagesDir, "ui");
    const siblingDir = path.join(packagesDir, "other");
    const modulePath = path.join(packageDir, "index.js");
    await fsp.mkdir(projectRoot, { recursive: true });
    await fsp.mkdir(packageDir, { recursive: true });
    await fsp.mkdir(siblingDir, { recursive: true });
    await fsp.writeFile(path.join(packageDir, "package.json"), '{"name":"@scope/ui"}');
    await fsp.writeFile(modulePath, "export {};");
    await fsp.writeFile(path.join(siblingDir, "secret.txt"), "regex-package-sibling-secret");

    const plugin = createOgInlinePlugin("build", projectRoot);
    const configResolved = unwrapHook(plugin.configResolved);
    configResolved.call(plugin, {
      command: "build",
      root: projectRoot,
      resolve: { alias: [{ find: /^@scope\/(.*)$/, replacement: `${packagesDir}/$1` }] },
    });
    const resolveId = unwrapHook(plugin.resolveId);
    await resolveId.call(
      { resolve: async () => ({ id: modulePath }) },
      "@scope/ui",
      path.join(projectRoot, "app.js"),
      {},
    );
    const transform = unwrapHook(plugin.transform);
    const code = `const data = fetch(new URL("../other/secret.txt", import.meta.url)).then((res) => res.arrayBuffer());`;
    const result = await transform.call(plugin, code, modulePath);

    expect(result).toBeNull();
  });

  it("confines a non-separator regular-expression capture targeting a package directory", async () => {
    const projectRoot = path.join(tmpDir, "regex-prefixed-package-app");
    const packagesDir = path.join(tmpDir, "regex-prefixed-package-libs");
    const packageDir = path.join(packagesDir, "acme-ui");
    const siblingDir = path.join(packagesDir, "acme-secrets");
    const modulePath = path.join(packageDir, "index.js");
    await fsp.mkdir(projectRoot, { recursive: true });
    await fsp.mkdir(packageDir, { recursive: true });
    await fsp.mkdir(siblingDir, { recursive: true });
    await fsp.writeFile(path.join(packageDir, "package.json"), '{"name":"@acme/ui"}');
    await fsp.writeFile(modulePath, "export {};");
    await fsp.writeFile(path.join(siblingDir, ".env"), "regex-prefixed-sibling-secret");

    const plugin = createOgInlinePlugin("build", projectRoot);
    const configResolved = unwrapHook(plugin.configResolved);
    configResolved.call(plugin, {
      command: "build",
      root: projectRoot,
      resolve: { alias: [{ find: /^@acme\/(.*)$/, replacement: `${packagesDir}/acme-$1` }] },
    });
    const resolveId = unwrapHook(plugin.resolveId);
    await resolveId.call(
      { resolve: async () => ({ id: modulePath }) },
      "@acme/ui",
      path.join(projectRoot, "app.js"),
      {},
    );
    const transform = unwrapHook(plugin.transform);
    const code = `const data = fetch(new URL("../acme-secrets/.env", import.meta.url)).then((res) => res.arrayBuffer());`;
    const result = await transform.call(plugin, code, modulePath);

    expect(result).toBeNull();
  });

  it("does not trust a string alias to an external non-package parent directory", async () => {
    const projectRoot = path.join(tmpDir, "string-parent-alias-app");
    const componentsDir = path.join(tmpDir, "string-parent-alias-components");
    const modulePath = path.join(componentsDir, "button", "index.js");
    await fsp.mkdir(projectRoot, { recursive: true });
    await fsp.mkdir(path.dirname(modulePath), { recursive: true });
    await fsp.writeFile(modulePath, "export {};");
    await fsp.writeFile(path.join(componentsDir, "secret-token.txt"), "parent-alias-secret");

    const plugin = createOgInlinePlugin("build", projectRoot);
    const configResolved = unwrapHook(plugin.configResolved);
    configResolved.call(plugin, {
      command: "build",
      root: projectRoot,
      resolve: { alias: [{ find: "@components", replacement: componentsDir }] },
    });
    const resolveId = unwrapHook(plugin.resolveId);
    await resolveId.call(
      { resolve: async () => ({ id: modulePath }) },
      "@components/button",
      path.join(projectRoot, "app.js"),
      {},
    );
    const transform = unwrapHook(plugin.transform);
    const code = `const data = fetch(new URL("../secret-token.txt", import.meta.url)).then((res) => res.arrayBuffer());`;
    const result = await transform.call(plugin, code, modulePath);

    expect(result).toBeNull();
  });

  it("tracks a single-segment scoped alias to an external package", async () => {
    const projectRoot = path.join(tmpDir, "single-segment-alias-app");
    const packageDir = path.join(tmpDir, "single-segment-alias-package");
    const modulePath = path.join(packageDir, "index.js");
    const packageFont = Buffer.from("single-segment-alias-font");
    await fsp.mkdir(projectRoot, { recursive: true });
    await fsp.mkdir(packageDir, { recursive: true });
    await fsp.writeFile(path.join(packageDir, "package.json"), '{"name":"design-system"}');
    await fsp.writeFile(modulePath, "export {};");
    await fsp.writeFile(path.join(packageDir, "font.ttf"), packageFont);

    const plugin = createOgInlinePlugin("build", projectRoot);
    const configResolved = unwrapHook(plugin.configResolved);
    configResolved.call(plugin, {
      command: "build",
      root: projectRoot,
      resolve: { alias: [{ find: "@ui", replacement: packageDir }] },
    });
    const resolveId = unwrapHook(plugin.resolveId);
    await resolveId.call(
      { resolve: async () => ({ id: modulePath }) },
      "@ui",
      path.join(projectRoot, "app.js"),
      {},
    );
    const transform = unwrapHook(plugin.transform);
    const code = `const data = fetch(new URL("./font.ttf", import.meta.url)).then((res) => res.arrayBuffer());`;
    const result = await transform.call(plugin, code, modulePath);

    expect(result?.code).toContain(packageFont.toString("base64"));
  });

  it("preserves configured precedence between regular-expression and string aliases", async () => {
    const projectRoot = path.join(tmpDir, "alias-precedence-app");
    const firstPackageDir = path.join(tmpDir, "alias-precedence-first");
    const secondPackageDir = path.join(tmpDir, "alias-precedence-second");
    const modulePath = path.join(firstPackageDir, "index.js");
    const packageFont = Buffer.from("alias-precedence-font");
    await fsp.mkdir(projectRoot, { recursive: true });
    await fsp.mkdir(firstPackageDir, { recursive: true });
    await fsp.mkdir(secondPackageDir, { recursive: true });
    await fsp.writeFile(path.join(firstPackageDir, "package.json"), '{"name":"first"}');
    await fsp.writeFile(path.join(secondPackageDir, "package.json"), '{"name":"second"}');
    await fsp.writeFile(modulePath, "export {};");
    await fsp.writeFile(path.join(firstPackageDir, "font.ttf"), packageFont);

    const plugin = createOgInlinePlugin("build", projectRoot);
    const configResolved = unwrapHook(plugin.configResolved);
    configResolved.call(plugin, {
      command: "build",
      root: projectRoot,
      resolve: {
        alias: [
          { find: /^@ui$/, replacement: firstPackageDir },
          { find: "@ui", replacement: secondPackageDir },
        ],
      },
    });
    const resolveId = unwrapHook(plugin.resolveId);
    await resolveId.call(
      { resolve: async () => ({ id: modulePath }) },
      "@ui",
      path.join(projectRoot, "app.js"),
      {},
    );
    const transform = unwrapHook(plugin.transform);
    const code = `const data = fetch(new URL("./font.ttf", import.meta.url)).then((res) => res.arrayBuffer());`;
    const result = await transform.call(plugin, code, modulePath);

    expect(result?.code).toContain(packageFont.toString("base64"));
  });

  it("inlines assets through a node_modules symlink to a workspace package", async () => {
    const workspaceRoot = path.join(tmpDir, "symlinked-workspace");
    const projectRoot = path.join(workspaceRoot, "app");
    const packageDir = path.join(workspaceRoot, "packages", "og-helper");
    const linkedPackageDir = path.join(projectRoot, "node_modules", "og-helper");
    const packageFont = Buffer.from("symlinked-workspace-font");
    await fsp.mkdir(path.dirname(linkedPackageDir), { recursive: true });
    await fsp.mkdir(packageDir, { recursive: true });
    await fsp.writeFile(path.join(packageDir, "package.json"), '{"name":"og-helper"}');
    await fsp.writeFile(path.join(packageDir, "font.ttf"), packageFont);
    await fsp.symlink(packageDir, linkedPackageDir, "dir");

    const plugin = createOgInlinePlugin("build", projectRoot);
    const transform = unwrapHook(plugin.transform);
    const code = `const data = fetch(new URL("./font.ttf", import.meta.url)).then((res) => res.arrayBuffer());`;
    const result = await transform.call(plugin, code, path.join(linkedPackageDir, "index.js"));

    expect(result?.code).toContain(packageFont.toString("base64"));
  });

  it("inlines assets beside a file-symlinked dependency module", async () => {
    const workspaceRoot = path.join(tmpDir, "file-symlinked-workspace");
    const projectRoot = path.join(workspaceRoot, "app");
    const packageDir = path.join(projectRoot, "node_modules", "og-helper");
    const workspacePackageDir = path.join(workspaceRoot, "packages", "og-helper");
    const packageFont = Buffer.from("file-symlinked-workspace-font");
    await fsp.mkdir(packageDir, { recursive: true });
    await fsp.mkdir(workspacePackageDir, { recursive: true });
    await fsp.writeFile(path.join(packageDir, "package.json"), '{"name":"og-helper"}');
    await fsp.writeFile(path.join(workspacePackageDir, "package.json"), '{"name":"og-helper"}');
    await fsp.writeFile(path.join(workspacePackageDir, "index.js"), "export {};");
    await fsp.writeFile(path.join(workspacePackageDir, "font.ttf"), packageFont);
    await fsp.symlink(
      path.join(workspacePackageDir, "index.js"),
      path.join(packageDir, "index.js"),
    );

    const plugin = createOgInlinePlugin("build", projectRoot);
    const transform = unwrapHook(plugin.transform);
    const code = `const data = fetch(new URL("./font.ttf", import.meta.url)).then((res) => res.arrayBuffer());`;
    const result = await transform.call(plugin, code, path.join(packageDir, "index.js"));

    expect(result?.code).toContain(packageFont.toString("base64"));
  });

  it("inlines assets for an aliased file-symlinked dependency", async () => {
    const workspaceRoot = path.join(tmpDir, "file-symlinked-alias");
    const projectRoot = path.join(workspaceRoot, "app");
    const packageDir = path.join(projectRoot, "node_modules", "og-alias");
    const workspacePackageDir = path.join(workspaceRoot, "packages", "og-helper");
    const packageFont = Buffer.from("file-symlinked-alias-font");
    await fsp.mkdir(packageDir, { recursive: true });
    await fsp.mkdir(workspacePackageDir, { recursive: true });
    await fsp.writeFile(path.join(packageDir, "package.json"), '{"name":"og-helper"}');
    await fsp.writeFile(path.join(workspacePackageDir, "package.json"), '{"name":"og-helper"}');
    await fsp.writeFile(path.join(workspacePackageDir, "index.js"), "export {};");
    await fsp.writeFile(path.join(workspacePackageDir, "font.ttf"), packageFont);
    await fsp.symlink(
      path.join(workspacePackageDir, "index.js"),
      path.join(packageDir, "index.js"),
    );

    const plugin = createOgInlinePlugin("build", projectRoot);
    const transform = unwrapHook(plugin.transform);
    const code = `const data = fetch(new URL("./font.ttf", import.meta.url)).then((res) => res.arrayBuffer());`;
    const result = await transform.call(plugin, code, path.join(packageDir, "index.js"));

    expect(result?.code).toContain(packageFont.toString("base64"));
  });

  it("does not broaden a file-symlinked dependency to an ancestor package", async () => {
    const workspaceRoot = path.join(tmpDir, "file-symlinked-ancestor");
    const projectRoot = path.join(workspaceRoot, "app");
    const packageDir = path.join(projectRoot, "node_modules", "og-helper");
    const workspacePackageDir = path.join(workspaceRoot, "packages", "og-helper");
    const secret = Buffer.from("ancestor-package-secret");
    await fsp.mkdir(packageDir, { recursive: true });
    await fsp.mkdir(workspacePackageDir, { recursive: true });
    await fsp.writeFile(path.join(workspaceRoot, "package.json"), '{"name":"workspace-root"}');
    await fsp.writeFile(path.join(packageDir, "package.json"), '{"name":"og-helper"}');
    await fsp.writeFile(path.join(workspacePackageDir, "index.js"), "export {};");
    await fsp.writeFile(path.join(workspaceRoot, "secret.txt"), secret);
    await fsp.symlink(
      path.join(workspacePackageDir, "index.js"),
      path.join(packageDir, "index.js"),
    );

    const plugin = createOgInlinePlugin("build", projectRoot);
    const transform = unwrapHook(plugin.transform);
    const code = `const data = fetch(new URL("../../secret.txt", import.meta.url)).then((res) => res.arrayBuffer());`;
    const result = await transform.call(plugin, code, path.join(packageDir, "index.js"));

    expect(result).toBeNull();
  });

  it("does not broaden a file-symlinked dependency to a same-named ancestor package", async () => {
    const workspaceRoot = path.join(tmpDir, "file-symlinked-same-name-ancestor");
    const projectRoot = path.join(workspaceRoot, "app");
    const packageDir = path.join(projectRoot, "node_modules", "og-helper");
    const workspacePackageDir = path.join(workspaceRoot, "packages", "manifest-less");
    const secret = Buffer.from("same-named-ancestor-secret");
    await fsp.mkdir(packageDir, { recursive: true });
    await fsp.mkdir(workspacePackageDir, { recursive: true });
    await fsp.writeFile(path.join(workspaceRoot, "package.json"), '{"name":"og-helper"}');
    await fsp.writeFile(path.join(packageDir, "package.json"), '{"name":"og-helper"}');
    await fsp.writeFile(path.join(workspacePackageDir, "index.js"), "export {};");
    await fsp.writeFile(path.join(workspaceRoot, "secret.txt"), secret);
    await fsp.symlink(
      path.join(workspacePackageDir, "index.js"),
      path.join(packageDir, "index.js"),
    );

    const plugin = createOgInlinePlugin("build", projectRoot);
    const transform = unwrapHook(plugin.transform);
    const code = `const data = fetch(new URL("../../secret.txt", import.meta.url)).then((res) => res.arrayBuffer());`;
    const result = await transform.call(plugin, code, path.join(packageDir, "index.js"));

    expect(result).toBeNull();
  });

  it("does not broaden a deep file symlink with a mismatched canonical package-relative path", async () => {
    const workspaceRoot = path.join(tmpDir, "file-symlinked-depth-mismatch");
    const projectRoot = path.join(workspaceRoot, "app");
    const packageDir = path.join(projectRoot, "node_modules", "og-helper");
    const targetDir = path.join(workspaceRoot, "pkg");
    await fsp.mkdir(path.join(packageDir, "dist"), { recursive: true });
    await fsp.mkdir(targetDir, { recursive: true });
    await fsp.writeFile(path.join(workspaceRoot, "package.json"), '{"name":"og-helper"}');
    await fsp.writeFile(path.join(packageDir, "package.json"), '{"name":"og-helper"}');
    await fsp.writeFile(path.join(targetDir, "index.js"), "export {};");
    await fsp.writeFile(path.join(workspaceRoot, "secret.txt"), "depth-mismatch-secret");
    await fsp.symlink(path.join(targetDir, "index.js"), path.join(packageDir, "dist", "index.js"));

    const plugin = createOgInlinePlugin("build", projectRoot);
    const transform = unwrapHook(plugin.transform);
    const code = `const data = fetch(new URL("../secret.txt", import.meta.url)).then((res) => res.arrayBuffer());`;
    const result = await transform.call(plugin, code, path.join(packageDir, "dist", "index.js"));

    expect(result).toBeNull();
  });

  it("does not broaden a manifest-less workspace module to the workspace root", async () => {
    const workspaceRoot = path.join(tmpDir, "manifest-less-workspace");
    const projectRoot = path.join(workspaceRoot, "app");
    const workspacePackageDir = path.join(workspaceRoot, "packages", "og-helper");
    await fsp.mkdir(projectRoot, { recursive: true });
    await fsp.mkdir(workspacePackageDir, { recursive: true });
    await fsp.writeFile(
      path.join(workspaceRoot, "package.json"),
      '{"name":"workspace-root","workspaces":["packages/*"]}',
    );
    await fsp.writeFile(path.join(workspacePackageDir, "index.js"), "export {};");
    await fsp.writeFile(path.join(workspaceRoot, "secret.txt"), "workspace-root-secret");

    const plugin = createOgInlinePlugin("build", projectRoot);
    const transform = unwrapHook(plugin.transform);
    const code = `const data = fetch(new URL("../../secret.txt", import.meta.url)).then((res) => res.arrayBuffer());`;
    const result = await transform.call(plugin, code, path.join(workspacePackageDir, "index.js"));

    expect(result).toBeNull();
  });

  it("does not broaden an external manifest-less module to its workspace root", async () => {
    const projectRoot = path.join(tmpDir, "external-workspace-app");
    const workspaceRoot = path.join(tmpDir, "external-workspace-owner");
    const workspacePackageDir = path.join(workspaceRoot, "packages", "og-helper");
    await fsp.mkdir(projectRoot, { recursive: true });
    await fsp.mkdir(workspacePackageDir, { recursive: true });
    await fsp.writeFile(path.join(workspaceRoot, "package.json"), '{"name":"workspace-root"}');
    await fsp.writeFile(path.join(workspacePackageDir, "index.js"), "export {};");
    await fsp.writeFile(path.join(workspaceRoot, "secret.txt"), "external-workspace-secret");

    const plugin = createOgInlinePlugin("build", projectRoot);
    const transform = unwrapHook(plugin.transform);
    const code = `const data = fetch(new URL("../../secret.txt", import.meta.url)).then((res) => res.arrayBuffer());`;
    const result = await transform.call(plugin, code, path.join(workspacePackageDir, "index.js"));

    expect(result).toBeNull();
  });

  it("does not authorize an external workspace ancestor with a different package name", async () => {
    const projectRoot = path.join(tmpDir, "external-named-workspace-app");
    const workspaceRoot = path.join(tmpDir, "og-helper");
    const workspacePackageDir = path.join(workspaceRoot, "packages", "ui");
    const modulePath = path.join(workspacePackageDir, "dist", "index.js");
    await fsp.mkdir(projectRoot, { recursive: true });
    await fsp.mkdir(path.dirname(modulePath), { recursive: true });
    await fsp.writeFile(path.join(workspaceRoot, "package.json"), '{"name":"@scope/og-helper"}');
    await fsp.writeFile(modulePath, "export {};");
    await fsp.writeFile(path.join(workspaceRoot, "secret.txt"), "external-named-secret");

    const plugin = createOgInlinePlugin("build", projectRoot);
    await resolveLinkedPackage(plugin, projectRoot, "@scope/ui", modulePath);
    const transform = unwrapHook(plugin.transform);
    const code = `const data = fetch(new URL("../../../secret.txt", import.meta.url)).then((res) => res.arrayBuffer());`;
    const result = await transform.call(plugin, code, modulePath);

    expect(result).toBeNull();
  });

  it.each([
    [
      "pnpm",
      path.join("node_modules", ".pnpm", "evil@1.0.0", "node_modules", "evil"),
      "../../../secret.txt",
    ],
    ["nested", path.join("node_modules", "parent", "node_modules", "evil"), "../../secret.txt"],
    [
      "nested scoped",
      path.join("node_modules", "parent", "node_modules", "@scope", "evil"),
      "../../../secret.txt",
    ],
  ])("does not inline targets outside a %s dependency package", async (_, packagePath, relPath) => {
    const projectRoot = path.join(
      tmpDir,
      `dependency-layout-${packagePath.replaceAll(path.sep, "-")}`,
    );
    const packageDir = path.join(projectRoot, packagePath);
    const secretPath = path.resolve(packageDir, relPath);
    await fsp.mkdir(packageDir, { recursive: true });
    await fsp.writeFile(path.join(packageDir, "package.json"), '{"name":"evil"}');
    await fsp.writeFile(secretPath, "dependency-layout-secret");

    const plugin = createOgInlinePlugin("build", projectRoot);
    const transform = unwrapHook(plugin.transform);
    const code = `const data = fetch(new URL(${JSON.stringify(relPath)}, import.meta.url)).then((res) => res.arrayBuffer());`;
    const result = await transform.call(plugin, code, path.join(packageDir, "index.js"));

    expect(result).toBeNull();
  });

  it("uses the project boundary when the project root is inside node_modules", async () => {
    const projectRoot = path.join(tmpDir, "nested-root", "node_modules", "host", "examples", "app");
    const secretPath = path.join(projectRoot, "..", "secret.txt");
    await fsp.mkdir(projectRoot, { recursive: true });
    await fsp.writeFile(secretPath, "outside-project-secret");

    const plugin = createOgInlinePlugin("build", projectRoot);
    const transform = unwrapHook(plugin.transform);
    const code = `const data = fetch(new URL("../secret.txt", import.meta.url)).then((res) => res.arrayBuffer());`;
    const result = await transform.call(plugin, code, path.join(projectRoot, "index.js"));

    expect(result).toBeNull();
  });

  it("inlines application assets when the project root is symlinked", async () => {
    const realProjectRoot = path.join(tmpDir, "symlinked-root-real");
    const linkedProjectRoot = path.join(tmpDir, "symlinked-root-link");
    const packageFont = Buffer.from("symlinked-project-font");
    await fsp.mkdir(realProjectRoot, { recursive: true });
    await fsp.writeFile(path.join(realProjectRoot, "font.ttf"), packageFont);
    await fsp.symlink(realProjectRoot, linkedProjectRoot, "dir");

    const plugin = createOgInlinePlugin("build", linkedProjectRoot);
    const transform = unwrapHook(plugin.transform);
    const code = `const data = fetch(new URL("./font.ttf", import.meta.url)).then((res) => res.arrayBuffer());`;
    const result = await transform.call(plugin, code, path.join(realProjectRoot, "index.js"));

    expect(result?.code).toContain(packageFont.toString("base64"));
  });

  it("inlines parent-relative application assets when the project root is symlinked", async () => {
    const realProjectRoot = path.join(tmpDir, "symlinked-parent-root-real");
    const linkedProjectRoot = path.join(tmpDir, "symlinked-parent-root-link");
    const routeDir = path.join(realProjectRoot, "app", "api", "og");
    const packageFont = Buffer.from("symlinked-parent-project-font");
    await fsp.mkdir(routeDir, { recursive: true });
    await fsp.writeFile(path.join(realProjectRoot, "font.ttf"), packageFont);
    await fsp.symlink(realProjectRoot, linkedProjectRoot, "dir");

    const plugin = createOgInlinePlugin("build", linkedProjectRoot);
    const transform = unwrapHook(plugin.transform);
    const code = `const data = fetch(new URL("../../../font.ttf", import.meta.url)).then((res) => res.arrayBuffer());`;
    const result = await transform.call(plugin, code, path.join(routeDir, "route.tsx"));

    expect(result?.code).toContain(packageFont.toString("base64"));
  });

  it("does not inline parent-relative assets outside a symlinked project root", async () => {
    const realProjectRoot = path.join(tmpDir, "symlinked-parent-escape-real");
    const linkedProjectRoot = path.join(tmpDir, "symlinked-parent-escape-link");
    const secretPath = path.join(tmpDir, "symlinked-parent-secret.txt");
    await fsp.mkdir(realProjectRoot, { recursive: true });
    await fsp.writeFile(secretPath, "symlinked-parent-secret");
    await fsp.symlink(realProjectRoot, linkedProjectRoot, "dir");

    const plugin = createOgInlinePlugin("build", linkedProjectRoot);
    const transform = unwrapHook(plugin.transform);
    const code = `const data = fetch(new URL("../symlinked-parent-secret.txt", import.meta.url)).then((res) => res.arrayBuffer());`;
    const result = await transform.call(
      plugin,
      code,
      path.join(realProjectRoot, "opengraph-image.tsx"),
    );

    expect(result).toBeNull();
  });

  it.each([
    [
      "fetch",
      `const data = fetch(new URL("./../../.env", import.meta.url)).then((res) => res.arrayBuffer());`,
    ],
    [
      "readFileSync",
      `const data = fs.readFileSync(fileURLToPath(new URL("./../../.env", import.meta.url)));`,
    ],
  ])("does not inline %s targets outside a dependency package", async (_, code) => {
    const secret = "CLOUDFLARE_API_TOKEN=demo-secret\n";
    const projectRoot = path.join(tmpDir, "dependency-boundary");
    const packageDir = path.join(projectRoot, "node_modules", "evil-og-helper");
    await fsp.mkdir(packageDir, { recursive: true });
    await fsp.writeFile(path.join(projectRoot, ".env"), secret);
    await fsp.writeFile(path.join(packageDir, "package.json"), '{"name":"evil-og-helper"}');

    const plugin = createOgInlinePlugin("build", projectRoot);
    const transform = unwrapHook(plugin.transform);
    const result = await transform.call(plugin, code, path.join(packageDir, "index.js"));

    expect(result).toBeNull();
  });

  it("does not inline assets that escape the allowed root through a symlink", async () => {
    const secret = "symlink-secret";
    const projectRoot = path.join(tmpDir, "symlink-boundary");
    const packageDir = path.join(projectRoot, "node_modules", "evil-og-helper");
    const secretPath = path.join(projectRoot, "secret.txt");
    await fsp.mkdir(packageDir, { recursive: true });
    await fsp.writeFile(path.join(packageDir, "package.json"), '{"name":"evil-og-helper"}');
    await fsp.writeFile(secretPath, secret);
    await fsp.symlink(secretPath, path.join(packageDir, "font.ttf"));

    const plugin = createOgInlinePlugin("build", projectRoot);
    const transform = unwrapHook(plugin.transform);
    const code = `const data = fetch(new URL("./font.ttf", import.meta.url)).then((res) => res.arrayBuffer());`;
    const result = await transform.call(plugin, code, path.join(packageDir, "index.js"));

    expect(result).toBeNull();
  });

  // ── File not found ───────────────────────────────────────

  it("silently skips when the referenced file does not exist", async () => {
    const plugin = createOgInlinePlugin();
    const transform = unwrapHook(plugin.transform);
    const code = `const data = fetch(new URL("./nonexistent.ttf", import.meta.url)).then((res) => res.arrayBuffer());`;
    const moduleId = path.join(tmpDir, "og.tsx");

    const result = await transform.call(plugin, code, moduleId);
    // No file found → no replacement → returns null
    expect(result).toBeNull();
  });

  // ── Async assertion ──────────────────────────────────────

  it("returns a Promise (hook is async)", () => {
    const plugin = createOgInlinePlugin();
    const transform = unwrapHook(plugin.transform);
    const code = `const data = fetch(new URL("./noto-sans.ttf", import.meta.url)).then((res) => res.arrayBuffer());`;
    const moduleId = path.join(tmpDir, "og.tsx");

    const result = transform.call(plugin, code, moduleId);
    expect(result).toBeInstanceOf(Promise);
    return result;
  });

  // ── Build cache hit ──────────────────────────────────────

  it("reads the file only once for repeated build transforms (cache hit)", async () => {
    const readFileSpy = vi.spyOn(fs.promises, "readFile");

    const plugin = createOgInlinePlugin("build");
    const transform = unwrapHook(plugin.transform);
    const code = `const buf = fs.readFileSync(fileURLToPath(new URL("./noto-sans.ttf", import.meta.url)));`;
    const moduleId = path.join(tmpDir, "og.tsx");

    // First call — should read from disk
    await transform.call(plugin, code, moduleId);

    // Second call — should use cache
    await transform.call(plugin, code, moduleId);

    // Exactly once: first call reads from disk, second call hits the build cache.
    const calls = readFileSpy.mock.calls.filter(
      (call) => call[0] === fs.realpathSync(path.join(tmpDir, "noto-sans.ttf")),
    );
    expect(calls.length).toBe(1);
  });

  // ── Dev mode stays fresh ─────────────────────────────────

  it("does not cache asset contents across serve transforms", async () => {
    const devFontPath = path.join(tmpDir, "dev-font.ttf");
    const initialFontBase64 = Buffer.from("dev-font-v1").toString("base64");
    const updatedFontBase64 = Buffer.from("dev-font-v2").toString("base64");
    await fsp.writeFile(devFontPath, Buffer.from("dev-font-v1"));

    const plugin = createOgInlinePlugin("serve");
    const transform = unwrapHook(plugin.transform);
    const code = `const buf = fs.readFileSync(fileURLToPath(new URL("./dev-font.ttf", import.meta.url)));`;
    const moduleId = path.join(tmpDir, "og.tsx");

    const firstResult = await transform.call(plugin, code, moduleId);
    expect(firstResult.code).toContain(initialFontBase64);

    await fsp.writeFile(devFontPath, Buffer.from("dev-font-v2"));

    const secondResult = await transform.call(plugin, code, moduleId);
    expect(secondResult.code).toContain(updatedFontBase64);
    expect(secondResult.code).not.toContain(initialFontBase64);
  });
});
