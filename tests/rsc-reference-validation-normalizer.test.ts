import { describe, expect, it } from "vitest";
import type { Plugin } from "vite";
import { createRscReferenceValidationNormalizerPlugin } from "../packages/vinext/src/plugins/rsc-reference-validation-normalizer.js";

function validationId(type: "client" | "server", id: string) {
  return `\0virtual:vite-rsc/reference-validation?type=${type}&id=${encodeURIComponent(id)}&lang.js`;
}

async function configurePlugin(manager: unknown): Promise<Plugin> {
  const plugin = createRscReferenceValidationNormalizerPlugin();
  if (typeof plugin.configResolved !== "function") {
    throw new Error("Expected function configResolved hook");
  }
  await plugin.configResolved.call(
    {} as never,
    {
      plugins: [
        {
          name: "rsc:minimal",
          api: { manager },
        },
      ],
    } as never,
  );
  return plugin;
}

async function load(plugin: Plugin, id: string): Promise<unknown> {
  const hook = typeof plugin.load === "function" ? plugin.load : plugin.load?.handler;
  if (typeof hook !== "function") throw new Error("Expected function load hook");
  return await hook.call({} as never, id);
}

describe("rsc reference validation normalizer", () => {
  it("only applies to the dev server, not build or preview", () => {
    const plugin = createRscReferenceValidationNormalizerPlugin();
    if (typeof plugin.apply !== "function") throw new Error("Expected function apply hook");

    expect(
      plugin.apply(
        {},
        {
          command: "serve",
          mode: "development",
          isPreview: false,
        },
      ),
    ).toBe(true);
    expect(
      plugin.apply(
        {},
        {
          command: "serve",
          mode: "production",
          isPreview: true,
        },
      ),
    ).toBe(false);
    expect(
      plugin.apply(
        {},
        {
          command: "build",
          mode: "production",
          isPreview: false,
        },
      ),
    ).toBe(false);
  });

  it("accepts decoded client reference ids when plugin-rsc has encoded metadata", async () => {
    const encodedReference =
      "/@id/__x00__virtual:vite-rsc/client-in-server-package-proxy/%2Fapp%2Fnode_modules%2Fvinext%2Fdist%2Fshims%2Fdefault-global-error.js";
    const decodedReference = encodedReference.replace("__x00__", "\0");
    const plugin = await configurePlugin({
      clientReferenceMetaMap: {
        "/@id/__x00__virtual:vite-rsc/client-in-server-package-proxy/test": {
          referenceKey: encodedReference,
        },
      },
    });

    await expect(load(plugin, validationId("client", decodedReference))).resolves.toBe("export {}");
  });

  it("accepts server reference ids when plugin-rsc has matching metadata", async () => {
    const plugin = await configurePlugin({
      serverReferenceMetaMap: {
        "/app/actions.ts": {
          referenceKey: "/app/actions.ts",
        },
      },
    });

    await expect(load(plugin, validationId("server", "/app/actions.ts"))).resolves.toBe(
      "export {}",
    );
  });

  it("falls through to plugin-rsc validation when metadata does not match", async () => {
    const plugin = await configurePlugin({
      clientReferenceMetaMap: {
        "/app/known.tsx": {
          referenceKey: "/app/known.tsx",
        },
      },
      serverReferenceMetaMap: {
        "/app/action.ts": {
          referenceKey: "/app/action.ts",
        },
      },
    });

    await expect(load(plugin, validationId("client", "/app/unknown.tsx"))).resolves.toBeNull();
    await expect(load(plugin, validationId("server", "/app/known.tsx"))).resolves.toBeNull();
  });

  it("falls through when plugin-rsc metadata is unavailable", async () => {
    const plugin = createRscReferenceValidationNormalizerPlugin();

    await expect(load(plugin, validationId("client", "/app/client.tsx"))).resolves.toBeNull();
  });
});
