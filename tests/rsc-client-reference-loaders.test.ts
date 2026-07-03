import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import type { Plugin } from "vite";
import {
  clientReferencesRequireRouterRuntime,
  createRscClientReferenceLoadersPlugin,
} from "../packages/vinext/src/plugins/rsc-client-reference-loaders.js";

function createSourceReader(entries: Record<string, string[] | null>) {
  return async (id: string) => entries[id] ?? null;
}

function createResolver(entries: Record<string, string>) {
  return async (source: string, importer: string) => {
    const id = entries[`${importer}:${source}`];
    return id === undefined ? null : { id };
  };
}

describe("client reference router runtime analysis", () => {
  const internalRoot = "/repo/packages/vinext/src";
  const routerRuntimeImportSpecifiers = new Set(["next/navigation"]);
  const routerRuntimeModuleIds = [
    "/repo/packages/vinext/src/shims/link.tsx",
    "/repo/packages/vinext/src/shims/navigation.ts",
  ];

  it("ignores vinext-owned client references that are not router runtime modules", async () => {
    await expect(
      clientReferencesRequireRouterRuntime({
        clientReferenceIds: ["/repo/packages/vinext/src/shims/error-boundary.tsx"],
        readImportSpecifiers: createSourceReader({}),
        resolveImport: createResolver({}),
        internalRoot,
        routerRuntimeImportSpecifiers,
        routerRuntimeModuleIds,
      }),
    ).resolves.toBe(false);
  });

  it("keeps the full runtime for vinext-owned router client references", async () => {
    await expect(
      clientReferencesRequireRouterRuntime({
        clientReferenceIds: ["/repo/packages/vinext/src/shims/link.tsx"],
        readImportSpecifiers: createSourceReader({}),
        resolveImport: createResolver({}),
        internalRoot,
        routerRuntimeImportSpecifiers,
        routerRuntimeModuleIds,
      }),
    ).resolves.toBe(true);
  });

  it("detects transitive router imports from user client references", async () => {
    await expect(
      clientReferencesRequireRouterRuntime({
        clientReferenceIds: ["/repo/app/counter.tsx"],
        readImportSpecifiers: createSourceReader({
          "/repo/app/counter.tsx": ["./use-navigation"],
          "/repo/app/use-navigation.ts": ["next/navigation"],
        }),
        resolveImport: createResolver({
          "/repo/app/counter.tsx:./use-navigation": "/repo/app/use-navigation.ts",
        }),
        internalRoot,
        routerRuntimeImportSpecifiers,
        routerRuntimeModuleIds,
      }),
    ).resolves.toBe(true);
  });

  it("allows router-independent user client references", async () => {
    await expect(
      clientReferencesRequireRouterRuntime({
        clientReferenceIds: ["/repo/app/counter.tsx"],
        readImportSpecifiers: createSourceReader({
          "/repo/app/counter.tsx": ["react"],
          "/repo/node_modules/react/index.js": [],
        }),
        resolveImport: createResolver({
          "/repo/app/counter.tsx:react": "/repo/node_modules/react/index.js",
        }),
        internalRoot,
        routerRuntimeImportSpecifiers,
        routerRuntimeModuleIds,
      }),
    ).resolves.toBe(false);
  });

  it("falls back to the full runtime when the graph is incomplete", async () => {
    await expect(
      clientReferencesRequireRouterRuntime({
        clientReferenceIds: ["/repo/app/counter.tsx"],
        readImportSpecifiers: createSourceReader({}),
        resolveImport: createResolver({}),
        internalRoot,
        routerRuntimeImportSpecifiers,
        routerRuntimeModuleIds,
      }),
    ).resolves.toBe(true);
  });

  it("detects direct router module ids even when Vite adds a query", async () => {
    await expect(
      clientReferencesRequireRouterRuntime({
        clientReferenceIds: ["/repo/app/counter.tsx"],
        readImportSpecifiers: createSourceReader({
          "/repo/app/counter.tsx": ["./navigation"],
        }),
        resolveImport: createResolver({
          "/repo/app/counter.tsx:./navigation": "/repo/packages/vinext/src/shims/navigation.ts?v=1",
        }),
        internalRoot,
        routerRuntimeImportSpecifiers,
        routerRuntimeModuleIds,
      }),
    ).resolves.toBe(true);
  });

  it("handles cycles in router-independent client reference graphs", async () => {
    await expect(
      clientReferencesRequireRouterRuntime({
        clientReferenceIds: ["/repo/app/a.tsx"],
        readImportSpecifiers: createSourceReader({
          "/repo/app/a.tsx": ["./b"],
          "/repo/app/b.tsx": ["./a"],
        }),
        resolveImport: createResolver({
          "/repo/app/a.tsx:./b": "/repo/app/b.tsx",
          "/repo/app/b.tsx:./a": "/repo/app/a.tsx",
        }),
        internalRoot,
        routerRuntimeImportSpecifiers,
        routerRuntimeModuleIds,
      }),
    ).resolves.toBe(false);
  });

  it("falls back to the full runtime for external dependencies", async () => {
    await expect(
      clientReferencesRequireRouterRuntime({
        clientReferenceIds: ["/repo/app/counter.tsx"],
        readImportSpecifiers: createSourceReader({
          "/repo/app/counter.tsx": ["external-package"],
        }),
        resolveImport: async () => ({ id: "external-package", external: true }),
        internalRoot,
        routerRuntimeImportSpecifiers,
        routerRuntimeModuleIds,
      }),
    ).resolves.toBe(true);
  });

  it("falls back to the full runtime when import resolution fails", async () => {
    await expect(
      clientReferencesRequireRouterRuntime({
        clientReferenceIds: ["/repo/app/counter.tsx"],
        readImportSpecifiers: createSourceReader({
          "/repo/app/counter.tsx": ["my-differentiated-files/browser"],
        }),
        resolveImport: async () => {
          throw new Error("No known conditions for ./browser specifier.");
        },
        internalRoot,
        routerRuntimeImportSpecifiers,
        routerRuntimeModuleIds,
      }),
    ).resolves.toBe(true);
  });

  it("detects static CommonJS router requires through the scan plugin", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-client-ref-scan-"));
    try {
      const clientReferenceId = path.join(root, "counter.js");
      await fs.writeFile(
        clientReferenceId,
        `"use client";\nconst navigation = require("next/navigation");\nexport { navigation };\n`,
      );

      let required: boolean | undefined;
      const plugin = createRscClientReferenceLoadersPlugin({
        internalRoot,
        routerRuntimeImportSpecifiers: ["next/navigation"],
        routerRuntimeModuleIds,
        onClientRouterRuntimeAnalysis(value) {
          required = value;
        },
      }) as Plugin;
      const manager = {
        isScanBuild: true,
        clientReferenceMetaMap: { [clientReferenceId]: {} },
        serverReferenceMetaMap: {},
      };

      await (plugin.configResolved as Function).call(plugin, {
        plugins: [{ name: "rsc:minimal", api: { manager } }],
      });
      await (plugin.generateBundle as Function).call({
        environment: { name: "rsc" },
        resolve: async () => null,
      });

      expect(required).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
