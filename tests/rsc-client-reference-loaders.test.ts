import { describe, expect, it } from "vite-plus/test";
import type { Plugin } from "vite";
import { createRscClientReferenceLoadersPlugin } from "../packages/vinext/src/plugins/rsc-client-reference-loaders.js";

const CLIENT_REFERENCES_ID = "\0virtual:vite-rsc/client-references";
const RUNTIME_IMPORT_PATTERN =
  /^import \{ loadClientReference \} from "([^"]*\/client\/chunk-load-recovery\.(?:ts|js))";\n/;

type Meta = {
  groupChunkId?: string;
  importId: string;
  referenceKey: string;
  renderedExports: string[];
  serverChunk?: string;
};
type Manager = { clientReferenceMetaMap: Record<string, Meta>; isScanBuild: boolean };
type TransformHook = {
  filter: { id: RegExp };
  handler(
    this: { environment: { name: string } },
    code: string,
    id: string,
  ): { code: string; map: null } | null;
};

function createPlugin(manager: Manager | undefined): { hook: TransformHook; plugin: Plugin } {
  const plugin = createRscClientReferenceLoadersPlugin();
  const configResolved = plugin.configResolved as (config: unknown) => void;
  configResolved({ plugins: [{ name: "rsc:minimal", api: manager ? { manager } : undefined }] });

  const transformHook = plugin.transform as unknown as TransformHook | TransformHook["handler"];
  const hook =
    typeof transformHook === "function"
      ? ({ filter: undefined, handler: transformHook } as unknown as TransformHook)
      : transformHook;

  return { hook, plugin };
}

function transform(hook: TransformHook, environment: string, id = CLIENT_REFERENCES_ID) {
  return hook.handler.call({ environment: { name: environment } }, "export default {}", id);
}

function createManager(metas: Record<string, Meta>, isScanBuild = false): Manager {
  return { clientReferenceMetaMap: metas, isScanBuild };
}

type LoaderMap = Record<string, () => Promise<Record<string, unknown>>>;

// Evaluates the generated module with its two free references stubbed.
async function evaluateLoaders(
  generated: string,
  fakes: {
    loadClientReference: (load: () => Promise<unknown>) => Promise<unknown>;
    importModule: (specifier: string) => Promise<unknown>;
  },
): Promise<LoaderMap> {
  const body = generated
    .replace(RUNTIME_IMPORT_PATTERN, "")
    .replace("export default", "return")
    .replace(/\bimport\(/g, "__import(");
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const evaluate = new AsyncFunction("loadClientReference", "__import", body);

  return evaluate(fakes.loadClientReference, fakes.importModule) as Promise<LoaderMap>;
}

const twoExportMetas = (): Record<string, Meta> => ({
  "/app/widget.tsx": {
    importId: "/app/widget.tsx",
    referenceKey: "widget",
    renderedExports: ["default", "Label"],
    serverChunk: "index",
  },
});

const SSR_OUTPUT = `export default {
  "widget": async () => {
    const m = await import("/app/widget.tsx");
    return {
      get "Label"() { return m["Label"]; },
      get "default"() { return m["default"]; },
    };
  },
};
`;

const CLIENT_OUTPUT = `export default {
  "widget": async () => {
    const m = await loadClientReference(() => import("/app/widget.tsx"));
    return {
      get "Label"() { return m["Label"]; },
      get "default"() { return m["default"]; },
    };
  },
};
`;

describe("rsc client reference loaders plugin", () => {
  describe("hook filter", () => {
    it("matches the client-references module id and no other id", () => {
      const { hook } = createPlugin(createManager({}));

      expect(hook.filter.id.test(CLIENT_REFERENCES_ID)).toBe(true);

      for (const other of [
        "virtual:vite-rsc/client-references",
        `${CLIENT_REFERENCES_ID}/group/chunk`,
        `${CLIENT_REFERENCES_ID}?v=1`,
        `x${CLIENT_REFERENCES_ID}`,
        "/src/app/page.tsx",
        "\0virtual:vite-rsc/resolved-id/x",
      ]) {
        expect(hook.filter.id.test(other), other).toBe(false);
      }
    });
  });

  describe("client environment", () => {
    it("wraps each import in loadClientReference and keeps the getter object", () => {
      const { hook } = createPlugin(createManager(twoExportMetas()));
      const result = transform(hook, "client");

      expect(result).not.toBeNull();
      const match = RUNTIME_IMPORT_PATTERN.exec(result!.code);
      expect(match).not.toBeNull();
      expect(result!.code.replace(RUNTIME_IMPORT_PATTERN, "")).toBe(CLIENT_OUTPUT);
      expect(result!.map).toBeNull();
    });

    it("imports the recovery primitive by absolute path", () => {
      const { hook } = createPlugin(createManager(twoExportMetas()));
      const specifier = RUNTIME_IMPORT_PATTERN.exec(transform(hook, "client")!.code)![1];

      expect(specifier.startsWith("/")).toBe(true);
    });

    it("returns both exports through lazy getters", async () => {
      const { hook } = createPlugin(createManager(twoExportMetas()));
      const reads: string[] = [];
      const calls: string[] = [];
      const namespace = {
        get Label() {
          reads.push("Label");
          return "label-value";
        },
        get default() {
          reads.push("default");
          return "default-value";
        },
      };
      const loaders = await evaluateLoaders(transform(hook, "client")!.code, {
        loadClientReference: async (load) => {
          calls.push("loadClientReference");
          return load();
        },
        importModule: async (specifier) => {
          calls.push(specifier);
          return namespace;
        },
      });

      const exported = await loaders.widget();

      expect(calls).toEqual(["loadClientReference", "/app/widget.tsx"]);
      expect(reads).toEqual([]);
      expect(exported.Label).toBe("label-value");
      expect(reads).toEqual(["Label"]);
      expect(exported.default).toBe("default-value");
      expect(reads).toEqual(["Label", "default"]);
    });

    it("rejects with the import failure passed through loadClientReference", async () => {
      const { hook } = createPlugin(createManager(twoExportMetas()));
      const failure = new Error("Failed to fetch dynamically imported module");
      const loaders = await evaluateLoaders(transform(hook, "client")!.code, {
        loadClientReference: (load) => load(),
        importModule: async () => {
          throw failure;
        },
      });

      await expect(loaders.widget()).rejects.toBe(failure);
    });

    it("proxies a \\0-prefixed import id inside the wrapped import", () => {
      const { hook } = createPlugin(
        createManager({
          "\0virtual:thing": {
            importId: "\0virtual:thing",
            referenceKey: "thing",
            renderedExports: ["default"],
            serverChunk: "index",
          },
        }),
      );
      const code = transform(hook, "client")!.code;

      expect(code).toContain(
        `await loadClientReference(() => import("virtual:vite-rsc/resolved-id/%00virtual%3Athing"))`,
      );
    });

    it("emits an empty object for a reference with no rendered exports and sorts by reference key", () => {
      const { hook } = createPlugin(
        createManager({
          "/b.tsx": {
            importId: "/b.tsx",
            referenceKey: "b",
            renderedExports: [],
            serverChunk: "index",
          },
          "/a.tsx": {
            importId: "/a.tsx",
            referenceKey: "a",
            renderedExports: ["default"],
            serverChunk: "index",
          },
        }),
      );
      const code = transform(hook, "client")!.code.replace(RUNTIME_IMPORT_PATTERN, "");

      expect(code).toBe(`export default {
  "a": async () => {
    const m = await loadClientReference(() => import("/a.tsx"));
    return {
      get "default"() { return m["default"]; },
    };
  },
  "b": async () => {
    const m = await loadClientReference(() => import("/b.tsx"));
    return {};
  },
};
`);
    });
  });

  describe("SSR environment", () => {
    it("keeps the direct loaders with no recovery import", () => {
      const { hook } = createPlugin(createManager(twoExportMetas()));
      const result = transform(hook, "ssr");

      expect(result).toEqual({ code: SSR_OUTPUT, map: null });
      expect(result!.code).not.toContain("loadClientReference");
    });
  });

  describe("shared behavior", () => {
    it("points groupChunkId at the meta map key in both environments", () => {
      for (const environment of ["client", "ssr"]) {
        const metas = twoExportMetas();
        const { hook } = createPlugin(createManager(metas));
        transform(hook, environment);

        expect(metas["/app/widget.tsx"].groupChunkId, environment).toBe("/app/widget.tsx");
      }
    });

    it("returns null when no meta has a server chunk", () => {
      for (const environment of ["client", "ssr"]) {
        const { hook } = createPlugin(
          createManager({
            "/app/widget.tsx": {
              importId: "/app/widget.tsx",
              referenceKey: "widget",
              renderedExports: ["default"],
            },
          }),
        );

        expect(transform(hook, environment), environment).toBeNull();
      }
    });

    it("returns null for an empty meta map", () => {
      for (const environment of ["client", "ssr"]) {
        const { hook } = createPlugin(createManager({}));

        expect(transform(hook, environment), environment).toBeNull();
      }
    });

    it("returns null during the scan build", () => {
      for (const environment of ["client", "ssr"]) {
        const { hook } = createPlugin(createManager(twoExportMetas(), true));

        expect(transform(hook, environment), environment).toBeNull();
      }
    });

    it("returns null when the RSC plugin api is unavailable", () => {
      const { hook } = createPlugin(undefined);

      expect(transform(hook, "client")).toBeNull();
    });
  });
});
