import { toFlightChunks, type ClientReferenceChunks } from "../utils/client-reference-chunks.js";

type ClientManifestEntry = { id: string; name: string; chunks: string[]; async?: boolean };
type ClientManifest = Record<string, ClientManifestEntry>;

/**
 * Names the chunks each client reference loads in its Flight row, as Next.js
 * does, so the browser loads a reference without a registry of every client
 * reference in the app (see shims/internal/client-reference-loader.ts). Returns a
 * function that wraps @vitejs/plugin-rsc's client manifest, which leaves the
 * chunks empty. Without chunk data (development, or `rsc: false`) it returns
 * the manifest unchanged.
 */
export function createClientReferenceChunksManifest(
  referenceChunks: ClientReferenceChunks | undefined,
): (manifest: ClientManifest) => ClientManifest {
  if (!referenceChunks) return (manifest) => manifest;
  const flightChunks = referenceChunks.modules.map(toFlightChunks);
  return (manifest) =>
    new Proxy(manifest, {
      get(target, id, receiver) {
        const entry: unknown = Reflect.get(target, id, receiver);
        if (typeof id !== "string" || !entry || typeof entry !== "object") return entry;
        const reference = entry as ClientManifestEntry;
        const index = Object.hasOwn(referenceChunks.references, reference.id)
          ? referenceChunks.references[reference.id]
          : undefined;
        return index === undefined ? reference : { ...reference, chunks: flightChunks[index] };
      },
    });
}

/**
 * The SSR Flight client's consumer manifest. React's webpack binding loads the
 * chunks a client reference's row names before requiring the reference, which
 * only the browser can do, so SSR resolves each reference to itself without
 * them. A null `moduleLoading` keeps React from preinitializing the chunks as
 * classic scripts; SSR preloads them through @vitejs/plugin-rsc instead.
 */
export const ssrServerConsumerManifest: {
  moduleMap: Record<string, Record<string, ClientManifestEntry>>;
  moduleLoading: null;
} = {
  moduleMap: new Proxy(
    {},
    {
      get(_target, id) {
        if (typeof id !== "string") return undefined;
        return new Proxy(
          {},
          {
            get(_exports, name) {
              return typeof name === "string" ? { id, chunks: [], name } : undefined;
            },
          },
        );
      },
    },
  ),
  moduleLoading: null,
};
