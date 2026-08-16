import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer, type Plugin } from "vite";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  createAppRouteRuntimePlugin,
  createAppRouteRuntimeServerReferenceMap,
  registerAppRouteRuntimeDevServerReference,
  registerAppRouteRuntimeServerReferences,
  withAppRouteRuntime,
} from "../packages/vinext/src/plugins/app-route-runtime.js";

function hookHandler<T>(hook: T | { handler: T }): T {
  return typeof hook === "object" && hook !== null && "handler" in hook ? hook.handler : hook;
}

function transformOutput(result: unknown): { code: string; map: unknown } {
  expect(result).toEqual(
    expect.objectContaining({ code: expect.any(String), map: expect.anything() }),
  );
  return result as { code: string; map: unknown };
}

type ServerReferenceMeta = {
  exportNames: string[];
  importId: string;
  referenceKey: string;
};

function createServerReferenceStore(
  initial: Record<string, ServerReferenceMeta> = {},
  resolveReference: (id: string) => ServerReferenceMeta = (id) => ({
    exportNames: [],
    importId: id,
    referenceKey: id,
  }),
) {
  const metaMap = new Map(Object.entries(initial));
  return {
    metaMap,
    resolve(id: string, _serverEnvironmentName: string) {
      return resolveReference(id);
    },
    replaceClaim(_owner: string, _id: string, meta: ServerReferenceMeta) {
      metaMap.set(meta.importId, meta);
    },
  };
}

describe("App route runtime module graph", () => {
  it("maps canonical server references to their edge-qualified counterparts", () => {
    const canonicalId = "/app/actions.ts";
    const edgeId = withAppRouteRuntime(canonicalId, "edge");

    expect(
      createAppRouteRuntimeServerReferenceMap(
        createServerReferenceStore({
          [canonicalId]: {
            exportNames: ["reportRuntime"],
            importId: canonicalId,
            referenceKey: "canonical-reference",
          },
          [edgeId]: {
            exportNames: ["reportRuntime"],
            importId: edgeId,
            referenceKey: "edge-reference",
          },
        }),
      ),
    ).toEqual({ "canonical-reference": "edge-reference" });
  });

  it("registers an edge loader for a client-only server reference used by an edge route", () => {
    const canonicalId = "/app/actions.ts";
    const edgeId = withAppRouteRuntime(canonicalId, "edge");
    const metas = createServerReferenceStore(
      {
        [canonicalId]: {
          exportNames: ["reportRuntime"],
          importId: canonicalId,
          referenceKey: "canonical-reference",
        },
      },
      (id) => ({
        exportNames: [],
        importId: id,
        referenceKey: "099064567bb9",
      }),
    );

    registerAppRouteRuntimeServerReferences(metas, [canonicalId]);

    expect(Object.fromEntries(metas.metaMap)).toEqual({
      [canonicalId]: {
        exportNames: ["reportRuntime"],
        importId: canonicalId,
        referenceKey: "canonical-reference",
      },
      [edgeId]: {
        exportNames: ["reportRuntime"],
        importId: edgeId,
        referenceKey: "099064567bb9",
      },
    });
    expect(createAppRouteRuntimeServerReferenceMap(metas)).toEqual({
      "canonical-reference": "099064567bb9",
    });
  });

  it("registers the runtime-qualified reference key used by Vite dev", () => {
    const canonicalId = "/project/app/actions.ts";
    const edgeId = withAppRouteRuntime(canonicalId, "edge");
    const metas = createServerReferenceStore({}, (id) => ({
      exportNames: [],
      importId: id,
      referenceKey: "/app/actions.ts?__vinext_app_runtime=edge",
    }));

    registerAppRouteRuntimeDevServerReference(metas, canonicalId);

    expect(Object.fromEntries(metas.metaMap)).toEqual({
      [edgeId]: {
        exportNames: [],
        importId: edgeId,
        referenceKey: "/app/actions.ts?__vinext_app_runtime=edge",
      },
    });
  });

  it("discovers a server reference imported only through an edge client boundary", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-runtime-client-action-"));
    const client = path.join(root, "client.tsx");
    const action = path.join(root, "actions.ts");
    await fs.writeFile(client, `"use client"\nimport { action } from "./actions"`);
    await fs.writeFile(action, `"use server"\nexport async function action() {}`);
    const onEdgeServerReference = vi.fn();
    const plugin = createAppRouteRuntimePlugin({ onEdgeServerReference });
    const resolve = vi.fn(async (source: string) => ({
      id: source === "./client" ? client : action,
    }));
    const resolveId = hookHandler(plugin.resolveId!);

    try {
      await resolveId.call(
        { environment: { name: "rsc" }, resolve } as unknown as ThisParameterType<typeof resolveId>,
        "./client",
        withAppRouteRuntime("/app/edge/page.tsx", "edge"),
        { attributes: {}, isEntry: false },
      );
      await resolveId.call(
        { environment: { name: "ssr" }, resolve } as unknown as ThisParameterType<typeof resolveId>,
        "./actions",
        client,
        { attributes: {}, isEntry: false },
      );

      expect(onEdgeServerReference).toHaveBeenCalledOnce();
      expect(onEdgeServerReference.mock.calls[0]?.[0]).toBe(action);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("propagates the edge runtime through server-side user imports", async () => {
    const plugin = createAppRouteRuntimePlugin();
    const resolve = vi.fn(async () => ({ id: "/app/shared.ts" }));
    const resolveId = hookHandler(plugin.resolveId!);
    const result = await resolveId.call(
      { resolve } as unknown as ThisParameterType<typeof resolveId>,
      "../shared",
      withAppRouteRuntime("/app/edge/page.tsx", "edge"),
      { attributes: {}, isEntry: false },
    );

    expect(resolve).toHaveBeenCalledWith("../shared", "/app/edge/page.tsx", {
      attributes: {},
      isEntry: false,
      skipSelf: true,
    });
    expect(result).toEqual({
      id: "/app/shared.ts?__vinext_app_runtime=edge",
    });
  });

  it("replaces NEXT_RUNTIME only inside a runtime-qualified server module", () => {
    const plugin = createAppRouteRuntimePlugin();
    const code = `export const runtime = process.env.NEXT_RUNTIME`;
    const transform = hookHandler(plugin.transform!);
    const result = transform.call(
      {} as ThisParameterType<typeof transform>,
      code,
      withAppRouteRuntime("/app/shared.ts", "edge"),
    );

    expect(transformOutput(result).code).toBe(`export const runtime = "edge"`);
  });

  it("does not replace NEXT_RUNTIME text in strings or comments", () => {
    const plugin = createAppRouteRuntimePlugin();
    const code = [
      `const text = "process.env.NEXT_RUNTIME"`,
      `// process.env.NEXT_RUNTIME`,
      `export const runtime = process.env.NEXT_RUNTIME`,
    ].join("\n");
    const transform = hookHandler(plugin.transform!);
    const result = transform.call(
      {} as ThisParameterType<typeof transform>,
      code,
      withAppRouteRuntime("/app/shared.ts", "nodejs"),
    );

    expect(transformOutput(result).code).toBe(
      [
        `const text = "process.env.NEXT_RUNTIME"`,
        `// process.env.NEXT_RUNTIME`,
        `export const runtime = "nodejs"`,
      ].join("\n"),
    );
  });

  it("propagates the runtime into dependencies", async () => {
    const plugin = createAppRouteRuntimePlugin();
    const resolve = vi.fn(async () => ({ id: "/app/node_modules/pkg/index.js" }));
    const resolveId = hookHandler(plugin.resolveId!);
    const result = await resolveId.call(
      { resolve } as unknown as ThisParameterType<typeof resolveId>,
      "pkg",
      withAppRouteRuntime("/app/edge/page.tsx", "edge"),
      { attributes: {}, isEntry: false },
    );

    expect(result).toEqual({
      id: "/app/node_modules/pkg/index.js?__vinext_app_runtime=edge",
    });
  });

  it("keeps a shared use client boundary on its canonical module id", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-runtime-boundary-"));
    const boundary = path.join(root, "boundary.ts");
    await fs.writeFile(boundary, `"use client"\nexport const value = 1`);
    const plugin = createAppRouteRuntimePlugin();
    const resolve = vi.fn(async () => ({ id: boundary }));
    const resolveId = hookHandler(plugin.resolveId!);

    try {
      const result = await resolveId.call(
        { resolve } as unknown as ThisParameterType<typeof resolveId>,
        "./boundary",
        withAppRouteRuntime("/app/edge/page.tsx", "edge"),
        { attributes: {}, isEntry: false },
      );
      expect(result).toEqual({ id: boundary });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps a shared use server boundary in the route runtime graph", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-runtime-boundary-"));
    const boundary = path.join(root, "boundary.ts");
    await fs.writeFile(boundary, `"use server"\nexport async function action() {}`);
    const plugin = createAppRouteRuntimePlugin();
    const resolve = vi.fn(async () => ({ id: boundary }));
    const resolveId = hookHandler(plugin.resolveId!);

    try {
      const result = await resolveId.call(
        { resolve } as unknown as ThisParameterType<typeof resolveId>,
        "./boundary",
        withAppRouteRuntime("/app/edge/page.tsx", "edge"),
        { attributes: {}, isEntry: false },
      );
      expect(result).toEqual({ id: withAppRouteRuntime(boundary, "edge") });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("preserves query-based loader semantics while propagating the runtime", async () => {
    const plugin = createAppRouteRuntimePlugin();
    const resolve = vi.fn(async () => ({ id: "/app/message.ts?raw" }));
    const resolveId = hookHandler(plugin.resolveId!);
    const result = await resolveId.call(
      { resolve } as unknown as ThisParameterType<typeof resolveId>,
      "./message.ts?raw",
      withAppRouteRuntime("/app/edge/page.tsx", "edge"),
      { attributes: {}, isEntry: false },
    );

    expect(result).toEqual({
      id: "/app/message.ts?raw&__vinext_app_runtime=edge",
    });
    expect(plugin.load).toBeUndefined();
  });

  it("runtime-qualifies executable MDX while preserving MDX asset queries", async () => {
    const plugin = createAppRouteRuntimePlugin();
    const resolve = vi.fn(async (source: string) => ({
      id: source.includes("?raw") ? "/app/content.mdx?raw" : "/app/content.mdx",
    }));
    const resolveId = hookHandler(plugin.resolveId!);
    const context = { resolve } as unknown as ThisParameterType<typeof resolveId>;
    const importer = withAppRouteRuntime("/app/edge/page.tsx", "edge");

    await expect(
      resolveId.call(context, "./content.mdx", importer, {
        attributes: {},
        isEntry: false,
      }),
    ).resolves.toEqual({
      id: "/app/content.mdx?__vinext_app_runtime=edge",
    });
    await expect(
      resolveId.call(context, "./content.mdx?raw", importer, {
        attributes: {},
        isEntry: false,
      }),
    ).resolves.toEqual({
      id: "/app/content.mdx?raw",
    });
  });

  it.each([
    ["Node built-in", "node:fs"],
    ["configured external package", "external-package"],
  ])("preserves a resolved %s", async (_label, externalId) => {
    const plugin = createAppRouteRuntimePlugin();
    const resolve = vi.fn(async () => ({ id: externalId, external: true }));
    const resolveId = hookHandler(plugin.resolveId!);
    const result = await resolveId.call(
      { resolve } as unknown as ThisParameterType<typeof resolveId>,
      externalId,
      withAppRouteRuntime("/app/edge/page.tsx", "edge"),
      { attributes: {}, isEntry: false },
    );

    expect(result).toEqual({ id: externalId, external: true });
  });

  it("transforms JavaScript returned by a virtual plugin loader", async () => {
    const virtualId = "\0runtime-generated";
    const dependencyId = "\0runtime-generated-dependency";
    const loaderQuery = "custom-loader=active";
    const loader: Plugin = {
      name: "test:runtime-generated-loader",
      resolveId(source, importer) {
        if (source === "./message.custom") return `${virtualId}?${loaderQuery}`;
        if (source === "./dependency.custom") {
          expect(importer).toBe(`${virtualId}?${loaderQuery}`);
          return dependencyId;
        }
      },
      load(id) {
        if (id.startsWith(`${virtualId}?`)) {
          return [
            `import dependencyRuntime from "./dependency.custom"`,
            `export default process.env.NEXT_RUNTIME + ":" + dependencyRuntime`,
          ].join("\n");
        }
        if (id.startsWith(`${dependencyId}?`)) return `export default process.env.NEXT_RUNTIME`;
      },
    };
    const server = await createServer({
      configFile: false,
      logLevel: "silent",
      plugins: [createAppRouteRuntimePlugin(), loader],
      server: { middlewareMode: true },
    });

    try {
      const pluginContainer = server.environments.ssr.pluginContainer;
      const resolved = await pluginContainer.resolveId(
        "./message.custom",
        withAppRouteRuntime("/app/edge/page.tsx", "edge"),
      );
      expect(resolved?.id).toBe(`${virtualId}?${loaderQuery}&__vinext_app_runtime=edge`);

      const loaded = await pluginContainer.load(resolved!.id);
      const code = typeof loaded === "string" ? loaded : loaded?.code;
      expect(code).toContain(`import dependencyRuntime from "./dependency.custom"`);

      const module = await server.ssrLoadModule(resolved!.id);
      expect(module.default).toBe("edge:edge");
    } finally {
      await server.close();
    }
  });

  it("does not qualify genuine non-JavaScript assets", async () => {
    const plugin = createAppRouteRuntimePlugin();
    const resolve = vi.fn(async () => ({ id: "/app/logo.svg" }));
    const resolveId = hookHandler(plugin.resolveId!);
    const result = await resolveId.call(
      { resolve } as unknown as ThisParameterType<typeof resolveId>,
      "./logo.svg",
      withAppRouteRuntime("/app/edge/page.tsx", "edge"),
      { attributes: {}, isEntry: false },
    );

    expect(result).toEqual({ id: "/app/logo.svg" });
  });

  it("does not qualify Vite RSC virtual modules with exact loader IDs", async () => {
    const plugin = createAppRouteRuntimePlugin();
    const virtualId = "\0virtual:vite-rsc/encryption-key";
    const resolve = vi.fn(async () => ({ id: virtualId }));
    const resolveId = hookHandler(plugin.resolveId!);
    const result = await resolveId.call(
      { resolve } as unknown as ThisParameterType<typeof resolveId>,
      "virtual:vite-rsc/encryption-key",
      withAppRouteRuntime("/app/edge/page.tsx", "edge"),
      { attributes: {}, isEntry: false },
    );

    expect(result).toEqual({ id: virtualId });
  });

  it("strips only runtime qualification from client modules", async () => {
    const plugin = createAppRouteRuntimePlugin();
    const resolve = vi.fn(async () => ({ id: "/app/client.tsx?raw&custom-loader=active" }));
    const resolveId = hookHandler(plugin.resolveId!);
    const result = await resolveId.call(
      { environment: { name: "client" }, resolve } as unknown as ThisParameterType<
        typeof resolveId
      >,
      withAppRouteRuntime("/app/client.tsx?raw&custom-loader=active", "edge"),
      undefined,
      { attributes: {}, isEntry: false },
    );

    expect(resolve).toHaveBeenCalledWith("/app/client.tsx?raw&custom-loader=active", undefined, {
      attributes: {},
      isEntry: false,
      skipSelf: true,
    });
    expect(result).toEqual({ id: "/app/client.tsx?raw&custom-loader=active" });
  });

  it("does not replace NEXT_RUNTIME in client transforms", () => {
    const plugin = createAppRouteRuntimePlugin();
    const code = `export const runtime = process.env.NEXT_RUNTIME`;
    const transform = hookHandler(plugin.transform!);
    const result = transform.call(
      { environment: { name: "client" } } as unknown as ThisParameterType<typeof transform>,
      code,
      withAppRouteRuntime("/app/client.tsx", "edge"),
    );

    expect(result).toBeNull();
  });
});
