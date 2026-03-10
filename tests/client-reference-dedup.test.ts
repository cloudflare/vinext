import { describe, it, expect } from "vitest";
import {
  extractPackageName,
  clientReferenceDedupPlugin,
} from "../packages/vinext/src/plugins/client-reference-dedup.js";

describe("extractPackageName", () => {
  it("extracts a regular package name", () => {
    expect(extractPackageName("/project/node_modules/react/index.js")).toBe("react");
  });

  it("extracts a scoped package name", () => {
    expect(extractPackageName("/project/node_modules/@mantine/core/esm/MantineProvider.mjs")).toBe(
      "@mantine/core",
    );
  });

  it("handles nested node_modules (uses last segment)", () => {
    expect(extractPackageName("/project/node_modules/foo/node_modules/@bar/baz/lib/index.js")).toBe(
      "@bar/baz",
    );
  });

  it("handles package name with no subpath", () => {
    expect(extractPackageName("/project/node_modules/lodash")).toBe("lodash");
  });

  it("returns null for paths without node_modules", () => {
    expect(extractPackageName("/project/src/components/Foo.tsx")).toBeNull();
  });

  it("returns null for incomplete scoped package", () => {
    expect(extractPackageName("/project/node_modules/@org")).toBeNull();
  });

  it("handles deeply nested submodule paths", () => {
    expect(
      extractPackageName(
        "/project/node_modules/@mantine/core/esm/components/TextInput/TextInput.mjs",
      ),
    ).toBe("@mantine/core");
  });
});

describe("clientReferenceDedupPlugin", () => {
  const plugin = clientReferenceDedupPlugin();
  const resolveId = (plugin.resolveId as any).handler;
  const load = (plugin.load as any).handler;

  function createContext(envName: string) {
    return { environment: { name: envName } };
  }

  describe("resolveId", () => {
    it("redirects absolute node_modules imports from proxy modules in client env", () => {
      const ctx = createContext("client");
      const result = resolveId.call(
        ctx,
        "/project/node_modules/@mantine/core/esm/MantineProvider.mjs",
        "\0virtual:vite-rsc/client-in-server-package-proxy/abc123",
      );
      expect(result).toBe("\0vinext:dedup/@mantine/core");
    });

    it("skips non-client environments", () => {
      const ctx = createContext("rsc");
      const result = resolveId.call(
        ctx,
        "/project/node_modules/@mantine/core/esm/MantineProvider.mjs",
        "\0virtual:vite-rsc/client-in-server-package-proxy/abc123",
      );
      expect(result).toBeUndefined();
    });

    it("skips imports not from proxy modules", () => {
      const ctx = createContext("client");
      const result = resolveId.call(
        ctx,
        "/project/node_modules/@mantine/core/esm/MantineProvider.mjs",
        "/project/src/App.tsx",
      );
      expect(result).toBeUndefined();
    });

    it("skips non-absolute paths", () => {
      const ctx = createContext("client");
      const result = resolveId.call(
        ctx,
        "@mantine/core",
        "\0virtual:vite-rsc/client-in-server-package-proxy/abc123",
      );
      expect(result).toBeUndefined();
    });

    it("skips paths without node_modules", () => {
      const ctx = createContext("client");
      const result = resolveId.call(
        ctx,
        "/project/src/components/Foo.tsx",
        "\0virtual:vite-rsc/client-in-server-package-proxy/abc123",
      );
      expect(result).toBeUndefined();
    });

    it("skips when importer is undefined", () => {
      const ctx = createContext("client");
      const result = resolveId.call(ctx, "/project/node_modules/react/index.js", undefined);
      expect(result).toBeUndefined();
    });

    it("respects optimizeDeps.exclude from resolved config", () => {
      const excludePlugin = clientReferenceDedupPlugin();
      // Simulate configResolved with @mantine/core excluded
      (excludePlugin.configResolved as any)({
        environments: {
          client: { optimizeDeps: { exclude: ["@mantine/core"] } },
        },
        optimizeDeps: {},
      });
      const excludeResolveId = (excludePlugin.resolveId as any).handler;
      const ctx = createContext("client");
      const result = excludeResolveId.call(
        ctx,
        "/project/node_modules/@mantine/core/esm/MantineProvider.mjs",
        "\0virtual:vite-rsc/client-in-server-package-proxy/abc123",
      );
      expect(result).toBeUndefined();
    });

    it("falls back to top-level optimizeDeps.exclude", () => {
      const excludePlugin = clientReferenceDedupPlugin();
      (excludePlugin.configResolved as any)({
        optimizeDeps: { exclude: ["some-pkg"] },
      });
      const excludeResolveId = (excludePlugin.resolveId as any).handler;
      const ctx = createContext("client");
      const result = excludeResolveId.call(
        ctx,
        "/project/node_modules/some-pkg/dist/index.mjs",
        "\0virtual:vite-rsc/client-in-server-package-proxy/abc123",
      );
      expect(result).toBeUndefined();
    });
  });

  describe("load", () => {
    it("generates bare specifier re-exports for dedup modules", () => {
      const ctx = {};
      const result = load.call(ctx, "\0vinext:dedup/@mantine/core");
      expect(result).toContain('export * from "@mantine/core"');
      expect(result).toContain('import * as __all__ from "@mantine/core"');
      expect(result).toContain("export default __all__.default");
    });

    it("generates correct output for unscoped packages", () => {
      const ctx = {};
      const result = load.call(ctx, "\0vinext:dedup/react");
      expect(result).toContain('export * from "react"');
      expect(result).toContain('import * as __all__ from "react"');
      expect(result).toContain("export default __all__.default");
    });

    it("skips non-dedup module IDs", () => {
      const ctx = {};
      const result = load.call(ctx, "\0some-other-virtual-module");
      expect(result).toBeUndefined();
    });
  });

  describe("plugin metadata", () => {
    it("has correct name", () => {
      expect(plugin.name).toBe("vinext:client-reference-dedup");
    });

    it("enforces pre", () => {
      expect(plugin.enforce).toBe("pre");
    });

    it("applies only in serve mode", () => {
      expect(plugin.apply).toBe("serve");
    });
  });
});
