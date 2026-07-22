import type { Plugin } from "vite";
import type { PluginApi } from "@vitejs/plugin-rsc";

const REFERENCE_VALIDATION_ID_PREFIX = "\0virtual:vite-rsc/reference-validation?";

type RscPluginWithApi = Plugin & {
  api?: PluginApi;
};

type RscReferenceMeta =
  | PluginApi["manager"]["clientReferenceMetaMap"][string]
  | PluginApi["manager"]["serverReferenceMetaMap"][string];

function parseReferenceValidationQuery(id: string): { type?: string; id?: string } | null {
  const queryStart = id.indexOf("?");
  if (queryStart === -1) return null;
  return Object.fromEntries(new URLSearchParams(id.slice(queryStart + 1)));
}

function normalizeReferenceKey(id: string): string {
  return id.replaceAll("\0", "__x00__");
}

function hasReference(
  referenceMetaMap: Record<string, RscReferenceMeta> | undefined,
  referenceId: string | undefined,
): boolean {
  if (!referenceMetaMap || !referenceId) return false;

  const normalizedReferenceId = normalizeReferenceKey(referenceId);
  return Object.values(referenceMetaMap).some(
    (meta) => normalizeReferenceKey(meta.referenceKey) === normalizedReferenceId,
  );
}

/**
 * @vitejs/plugin-rsc stores dev virtual client-reference keys in Vite's encoded
 * `/@id/__x00__...` form, but React's SSR consumer can ask validation for the
 * decoded `/@id/\0...` form. Treat those as equivalent and fall through to the
 * upstream validator for all other invalid references.
 */
export function createRscReferenceValidationNormalizerPlugin(): Plugin {
  let rscApi: PluginApi | undefined;

  return {
    name: "vinext:rsc-reference-validation-normalizer",
    enforce: "pre",
    apply(_config, env) {
      return env.command === "serve" && env.isPreview !== true;
    },
    configResolved(config) {
      rscApi = (
        config.plugins.find((plugin) => plugin.name === "rsc:minimal") as
          | RscPluginWithApi
          | undefined
      )?.api;
    },
    load: {
      // oxlint-disable-next-line no-control-regex -- null byte prefix is intentional (Vite virtual module convention)
      filter: { id: /^\u0000virtual:vite-rsc\/reference-validation\?/ },
      handler(id) {
        if (!id.startsWith(REFERENCE_VALIDATION_ID_PREFIX)) return null;

        const query = parseReferenceValidationQuery(id);
        if (!query) return null;

        const manager = rscApi?.manager;
        if (query.type === "client" && hasReference(manager?.clientReferenceMetaMap, query.id)) {
          return "export {}";
        }

        if (query.type === "server" && hasReference(manager?.serverReferenceMetaMap, query.id)) {
          return "export {}";
        }

        return null;
      },
    },
  };
}
