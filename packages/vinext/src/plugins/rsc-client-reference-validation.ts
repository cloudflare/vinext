import type { Plugin } from "vite";
import { RSC_CLIENT_SHIM_SPECIFIERS } from "./rsc-client-shim-excludes.js";

const REFERENCE_VALIDATION_PREFIX = "\0virtual:vite-rsc/reference-validation?";
const CLIENT_PACKAGE_PROXY = "virtual:vite-rsc/client-package-proxy/";
const CLIENT_IN_SERVER_PACKAGE_PROXY = "virtual:vite-rsc/client-in-server-package-proxy/";
const REMOVE_DUPLICATE_SERVER_CSS_REFERENCE = "/@id/\0virtual:vite-rsc/remove-duplicate-server-css";
const NEXT_CLIENT_SHIM_SPECIFIERS = new Set([
  "next/form",
  "next/image",
  "next/link",
  "next/script",
]);
const VINEXT_CLIENT_SHIM_NAMES = new Set(
  RSC_CLIENT_SHIM_SPECIFIERS.map((specifier) => specifier.slice("vinext/shims/".length)),
);

function decodeProxyModuleId(referenceId: string): string | null {
  const markerIndex = referenceId.indexOf(CLIENT_IN_SERVER_PACKAGE_PROXY);
  if (markerIndex === -1) return null;

  const encodedModuleId = referenceId.slice(markerIndex + CLIENT_IN_SERVER_PACKAGE_PROXY.length);
  try {
    return decodeURIComponent(encodedModuleId).replaceAll("\\", "/");
  } catch {
    return encodedModuleId.replaceAll("\\", "/");
  }
}

function decodePackageProxySpecifier(referenceId: string): string | null {
  const markerIndex = referenceId.indexOf(CLIENT_PACKAGE_PROXY);
  if (markerIndex === -1) return null;
  return referenceId.slice(markerIndex + CLIENT_PACKAGE_PROXY.length);
}

export function isVinextRscClientReferenceValidation(id: string): boolean {
  if (!id.startsWith(REFERENCE_VALIDATION_PREFIX)) return false;

  const queryIndex = id.indexOf("?");
  if (queryIndex === -1) return false;

  const params = new URLSearchParams(id.slice(queryIndex + 1));
  if (params.get("type") !== "client") return false;

  const referenceId = params.get("id") ?? "";
  if (referenceId === REMOVE_DUPLICATE_SERVER_CSS_REFERENCE) return true;

  const packageSpecifier = decodePackageProxySpecifier(referenceId);
  if (
    packageSpecifier &&
    (NEXT_CLIENT_SHIM_SPECIFIERS.has(packageSpecifier) ||
      RSC_CLIENT_SHIM_SPECIFIERS.includes(packageSpecifier))
  ) {
    return true;
  }

  const moduleId = decodeProxyModuleId(referenceId);
  if (!moduleId) return false;

  const match = moduleId.match(
    /(?:^|\/)node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?vinext\/dist\/shims\/([^/]+)\.js$/,
  );
  if (!match) return false;

  return VINEXT_CLIENT_SHIM_NAMES.has(match[1]);
}

export function rscClientReferenceValidationPlugin(): Plugin {
  return {
    name: "vinext:rsc-client-reference-validation",
    enforce: "pre",
    apply: "serve",

    load: {
      // oxlint-disable-next-line no-control-regex -- null byte prefix is intentional (Vite virtual module convention)
      filter: { id: /^\u0000virtual:vite-rsc\/reference-validation\?/ },
      handler(id) {
        // Vite decodes `/@id/__x00__...` back to a NUL-prefixed id before
        // plugin-rsc validates it. Accept only the framework-owned client
        // references whose metadata vinext intentionally wires into the graph.
        if (!isVinextRscClientReferenceValidation(id)) return;
        return "export {};";
      },
    },
  };
}
