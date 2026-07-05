import fs from "node:fs";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";
import { createRequireExportConditionPlugin } from "../packages/vinext/src/plugins/require-export-condition.js";

async function withModule(content: string, run: (id: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "vinext-require-condition-"));
  const id = path.join(root, "index.js");
  fs.writeFileSync(id, content);
  try {
    await run(id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function getTransform(plugin: ReturnType<typeof createRequireExportConditionPlugin>) {
  return plugin.transform as unknown as {
    filter: { id: { exclude: RegExp } };
    handler: (
      this: { environment?: { name: string }; resolve: ReturnType<typeof vi.fn> },
      code: string,
      id: string,
    ) => Promise<{ code: string } | null>;
  };
}

function proxyId(specifier: string, importer = "/app/page.tsx"): string {
  const importerHash = createHash("sha256").update(importer).digest("hex").slice(0, 16);
  return `virtual:vinext-require-condition:${importerHash}:${encodeURIComponent(specifier)}`;
}

function expectedResolvedProxyId(specifier: string, importer = "/app/page.tsx"): string {
  return `\0${proxyId(specifier, importer)}.vinext-require.js`;
}

describe("require export conditions", () => {
  it("rewrites client package requires using require-condition resolution", async () => {
    await withModule(`'use client'; module.exports = () => 'client';`, async (moduleId) => {
      const plugin = createRequireExportConditionPlugin();
      const resolve = vi.fn().mockImplementation(async (specifier: string) => {
        if (specifier === "client-pkg") return { id: moduleId };
        return null;
      });

      const result = await getTransform(plugin).handler.call(
        { environment: { name: "rsc" }, resolve },
        `const packageValue = require("client-pkg");
const relativeValue = require("./relative.js");
const dynamicValue = require(name);`,
        "/app/page.tsx",
      );

      expect(result?.code).toContain(
        `require(${JSON.stringify(proxyId("client-pkg"))}).__vinextRequireValue`,
      );
      expect(result?.code).toContain('require("./relative.js")');
      expect(result?.code).toContain("require(name)");

      const resolveId = plugin.resolveId as unknown as (
        this: { resolve: typeof resolve },
        id: string,
        importer: string,
      ) => Promise<unknown>;
      await expect(
        resolveId.call({ resolve }, proxyId("client-pkg"), "/app/page.tsx"),
      ).resolves.toBe(expectedResolvedProxyId("client-pkg"));
      expect(resolve).toHaveBeenCalledWith("client-pkg", "/app/page.tsx", {
        skipSelf: true,
        kind: "require-call",
      });
    });
  });

  it("leaves normal server and virtual requires to the existing pipeline", async () => {
    await withModule(`module.exports = { value: "server" };`, async (moduleId) => {
      const plugin = createRequireExportConditionPlugin();
      const resolve = vi.fn().mockImplementation(async (specifier: string) => {
        if (specifier === "server-pkg") return { id: moduleId };
        if (specifier === "server-only") {
          return { id: "\0virtual:vite-rsc/validate-imports/valid/server-only" };
        }
        return null;
      });

      const resolveId = plugin.resolveId as unknown as (
        this: { resolve: typeof resolve },
        id: string,
        importer: string,
      ) => Promise<unknown>;
      const serverProxyId = await resolveId.call(
        { resolve },
        proxyId("server-pkg"),
        "/app/page.tsx",
      );
      expect(serverProxyId).toBe(expectedResolvedProxyId("server-pkg"));
      const load = plugin.load as (id: string) => string | null;
      expect(load(String(serverProxyId))).not.toContain("'use client'");
      expect(load(String(serverProxyId))).toContain("export { value as __vinextRequireValue };");
      await expect(
        resolveId.call({ resolve }, proxyId("server-pkg"), "/app/page.tsx"),
      ).resolves.toBe(serverProxyId);
      await expect(
        resolveId.call({ resolve }, proxyId("server-only"), "/app/page.tsx"),
      ).resolves.toEqual({ id: "\0virtual:vite-rsc/validate-imports/valid/server-only" });
    });
  });

  it("preserves package aliases resolved outside node_modules", async () => {
    const plugin = createRequireExportConditionPlugin();
    const resolve = vi.fn().mockResolvedValue({ id: "/vinext/shims/headers.ts" });
    const resolveId = plugin.resolveId as unknown as (
      this: { resolve: typeof resolve },
      id: string,
      importer: string,
    ) => Promise<unknown>;

    await expect(
      resolveId.call({ resolve }, proxyId("next/headers"), "/app/page.tsx"),
    ).resolves.toBe(expectedResolvedProxyId("next/headers"));
  });

  it("loads external packages through createRequire at runtime", async () => {
    const externalRequireSpecifiers = new Set<string>();
    const plugin = createRequireExportConditionPlugin({ externalRequireSpecifiers });
    const resolve = vi.fn().mockResolvedValue({ id: "external-pkg", external: true });
    const resolveId = plugin.resolveId as unknown as (
      this: { resolve: typeof resolve },
      id: string,
      importer: string,
    ) => Promise<string | null>;
    const resolvedProxyId = await resolveId.call(
      { resolve },
      proxyId("external-pkg"),
      "/app/page.tsx",
    );
    expect(resolvedProxyId).toBe(expectedResolvedProxyId("external-pkg"));
    expect(externalRequireSpecifiers).toEqual(new Set(["external-pkg"]));

    const load = plugin.load as (id: string) => string | null;
    expect(load(resolvedProxyId ?? "")).toContain('createRequire(import.meta.url)("external-pkg")');
  });

  it("preserves falsy client module defaults", async () => {
    await withModule(`'use client'; export default false;`, async (moduleId) => {
      const plugin = createRequireExportConditionPlugin();
      const resolve = vi.fn().mockResolvedValue({ id: moduleId });
      const resolveId = plugin.resolveId as unknown as (
        this: { resolve: typeof resolve },
        id: string,
        importer: string,
      ) => Promise<string | null>;
      const resolvedProxyId = await resolveId.call(
        { environment: { name: "rsc" }, resolve },
        proxyId("client-pkg"),
        "/app/page.tsx",
      );
      const load = plugin.load as (id: string) => string | null;

      const code = load(resolvedProxyId ?? "");
      expect(code).toContain(
        'const value = "default" in namespace ? namespace.default : namespace;',
      );
      expect(code).toContain("export { value as __vinextRequireValue };");
      expect(code).not.toContain("export default");
    });
  });

  it("leaves calls alone when require is locally bound", async () => {
    const plugin = createRequireExportConditionPlugin();
    const resolve = vi.fn();

    await expect(
      getTransform(plugin).handler.call(
        { environment: { name: "rsc" }, resolve },
        `function load(require: (id: string) => unknown) {
  return require("pkg");
}`,
        "/app/page.tsx",
      ),
    ).resolves.toBeNull();
    expect(resolve).not.toHaveBeenCalled();
  });

  it("does not rewrite when require is bound in module scope", async () => {
    const plugin = createRequireExportConditionPlugin();
    const resolve = vi.fn();

    await expect(
      getTransform(plugin).handler.call(
        { environment: { name: "rsc" }, resolve },
        `const require = createRequire(import.meta.url);
const value = require("pkg");`,
        "/app/page.tsx",
      ),
    ).resolves.toBeNull();
    expect(resolve).not.toHaveBeenCalled();
  });

  it("rewrites unbound requires even when a nested scope binds require", async () => {
    await withModule(`module.exports = { value: "server" };`, async (moduleId) => {
      const plugin = createRequireExportConditionPlugin();
      const resolve = vi.fn().mockImplementation(async (specifier: string) => {
        if (specifier === "server-pkg") return { id: moduleId };
        throw new Error(`unexpected resolve: ${specifier}`);
      });

      const result = await getTransform(plugin).handler.call(
        { environment: { name: "rsc" }, resolve },
        `const value = require("server-pkg");
function helper(require: (id: string) => unknown) {
  return require("shadowed-pkg");
}`,
        "/app/page.tsx",
      );

      expect(result?.code).toContain(
        `require(${JSON.stringify(proxyId("server-pkg"))}).__vinextRequireValue`,
      );
      expect(result?.code).toContain('return require("shadowed-pkg");');
      expect(resolve).toHaveBeenCalledOnce();
      expect(resolve).toHaveBeenCalledWith("server-pkg", "/app/page.tsx", {
        skipSelf: true,
        kind: "require-call",
      });
    });
  });

  it("leaves bare Node builtins alone", async () => {
    const plugin = createRequireExportConditionPlugin();
    const resolve = vi.fn();

    await expect(
      getTransform(plugin).handler.call(
        { environment: { name: "rsc" }, resolve },
        `const fs = require("fs");
const path = require("node:path");`,
        "/app/page.tsx",
      ),
    ).resolves.toBeNull();
    expect(resolve).not.toHaveBeenCalled();
  });

  it("keeps proxy modules distinct for different importers", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "vinext-require-importers-"));
    const firstModule = path.join(root, "first.js");
    const secondModule = path.join(root, "second.js");
    fs.writeFileSync(firstModule, `module.exports = "first";`);
    fs.writeFileSync(secondModule, `module.exports = "second";`);
    try {
      const plugin = createRequireExportConditionPlugin();
      const resolve = vi.fn().mockImplementation(async (_specifier: string, importer: string) => ({
        id: importer.includes("first") ? firstModule : secondModule,
      }));
      const transform = getTransform(plugin);
      const firstImporter = "/app/first/page.tsx";
      const secondImporter = "/app/second/page.tsx";
      await transform.handler.call(
        { environment: { name: "rsc" }, resolve },
        `const value = require("pkg");`,
        firstImporter,
      );
      await transform.handler.call(
        { environment: { name: "rsc" }, resolve },
        `const value = require("pkg");`,
        secondImporter,
      );
      const resolveId = plugin.resolveId as unknown as (
        this: { resolve: typeof resolve },
        id: string,
        importer: string,
      ) => Promise<string | null>;
      const firstProxy = await resolveId.call(
        { resolve },
        proxyId("pkg", firstImporter),
        firstImporter,
      );
      const secondProxy = await resolveId.call(
        { resolve },
        proxyId("pkg", secondImporter),
        secondImporter,
      );

      expect(firstProxy).not.toBe(secondProxy);
      const load = plugin.load as (id: string) => string | null;
      expect(load(firstProxy ?? "")).toContain(firstModule);
      expect(load(secondProxy ?? "")).toContain(secondModule);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not rewrite requires from dependency modules", async () => {
    const plugin = createRequireExportConditionPlugin();
    const resolve = vi.fn();
    const transform = getTransform(plugin);

    expect(transform.filter.id.exclude.test("/app/node_modules/pkg/index.js")).toBe(true);
    expect(transform.filter.id.exclude.test("C:\\app\\node_modules\\pkg\\index.js")).toBe(true);
    await expect(
      transform.handler.call(
        { environment: { name: "rsc" }, resolve },
        `const value = require("pkg");`,
        "/app/node_modules/pkg/index.js",
      ),
    ).resolves.toBeNull();
    expect(resolve).not.toHaveBeenCalled();
  });

  it("does not rewrite requires outside the RSC environment", async () => {
    const plugin = createRequireExportConditionPlugin();
    const resolve = vi.fn();

    await expect(
      getTransform(plugin).handler.call(
        { environment: { name: "ssr" }, resolve },
        `const value = require("pkg");`,
        "/pages/index.tsx",
      ),
    ).resolves.toBeNull();
    expect(resolve).not.toHaveBeenCalled();
  });
});
