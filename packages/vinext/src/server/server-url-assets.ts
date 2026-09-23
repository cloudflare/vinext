/**
 * Runtime half of the `vinext:server-url-assets` plugin.
 *
 * Server code (edge API routes, middleware, route handlers, OG routes) loads
 * files with `fetch(new URL("./asset", import.meta.url))`. Next.js's edge
 * compiler emits each referenced file as an edge asset and short-circuits
 * `fetch()` for those URLs (`fetchInlineAsset` in
 * packages/next/src/server/web/sandbox/fetch-inline-assets.ts). Plain runtimes
 * cannot do that on their own: Node's fetch rejects `file:` URLs ("not
 * implemented... yet...") and Workers have no filesystem at all.
 *
 * The plugin rewrites each reference to a build-time-registered URL whose bytes
 * ship in a lazily imported chunk. This module keeps that registry on
 * `globalThis` (shared across Vite's per-environment module instances) and
 * answers `fetch()` for registered URLs only — arbitrary `file:` URLs still go
 * to the platform fetch, so request-controlled input cannot read arbitrary
 * local files. Like Next.js's `blob:` asset names, a registered URL is matched
 * by string, so it serves bytes that already ship in the server bundle.
 *
 * Keep this module tiny: the fetch-cache shim imports it on every server
 * bundle's fetch path.
 */

type ServerUrlAssetBytesModule = { default: Uint8Array };

export type ServerUrlAssetLoader = () => Promise<ServerUrlAssetBytesModule>;

type ServerUrlAssetState = {
  assets: Map<string, ServerUrlAssetLoader>;
  fetchWrapped: boolean;
};

const STATE_KEY = Symbol.for("vinext.serverUrlAssets");
const globalState = globalThis as unknown as Record<PropertyKey, ServerUrlAssetState | undefined>;

function getState(): ServerUrlAssetState {
  return (globalState[STATE_KEY] ??= { assets: new Map(), fetchWrapped: false });
}

/**
 * Register the bytes loader for a server URL asset and return its URL.
 *
 * Called from the generated `\0vinext-server-url-asset:<path>` module, which
 * every rewritten `new URL(...)` reference imports, so registration always
 * completes before the referencing module body (and any module-scope fetch)
 * runs.
 */
export function registerServerUrlAsset(href: string, load: ServerUrlAssetLoader): string {
  const state = getState();
  state.assets.set(href, load);
  if (!state.fetchWrapped) {
    state.fetchWrapped = true;
    // The fetch-cache shim replaces globalThis.fetch with a wrapper around the
    // platform fetch it captured at import time, dropping this wrapper; it
    // therefore consults fetchServerUrlAsset() itself. This wrapper covers
    // fetches that run before (or without) that patch, e.g. module-scope font
    // loads in OG routes.
    const nextFetch = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
      fetchServerUrlAsset(input) ?? nextFetch(input, init)) as typeof globalThis.fetch;
  }
  return href;
}

/**
 * Serve a registered server URL asset, or return `undefined` so the caller
 * falls through to the real fetch. Mirrors Next.js's `fetchInlineAsset`: the
 * input is matched by URL string, the method and init are ignored, and the
 * response carries only the asset bytes (no content-type).
 */
export function fetchServerUrlAsset(input: unknown): Promise<Response> | undefined {
  const state = globalState[STATE_KEY];
  if (state === undefined || state.assets.size === 0) return undefined;

  const href = typeof input === "string" ? input : input instanceof URL ? input.href : undefined;
  if (href === undefined) return undefined;

  const load = state.assets.get(href);
  if (load === undefined) return undefined;

  // Copy so a consumer that transfers or mutates the body cannot corrupt the
  // module-owned bytes served to later fetches.
  return load().then((bytes) => new Response(bytes.default.slice()));
}

type Uint8ArrayWithBase64 = typeof Uint8Array & {
  fromBase64?: (base64: string) => Uint8Array;
};

/** Decode the base64 payload of a generated asset bytes module. */
export function decodeServerUrlAsset(base64: string): Uint8Array {
  const typedArray = Uint8Array as Uint8ArrayWithBase64;
  if (typeof typedArray.fromBase64 === "function") return typedArray.fromBase64(base64);

  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
