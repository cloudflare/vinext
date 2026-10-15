import {
  COLON_BYTE,
  COMMA_BYTE,
  NEWLINE_BYTE,
  concatBytes,
  indexOfByte,
  isLengthPrefixedRowTag,
  isNewlineFramedRowTag,
  isUntaggedJsonRowStart,
  parseHexBytes,
} from "./rsc-stream-hints.js";

type ClientReferenceRequire = (id: string) => Promise<unknown>;

type ClientReferenceMap = Readonly<Record<string, unknown>>;

type ClientReferencePreloaderOptions = {
  getReferences: () => ClientReferenceMap | undefined;
  getClientRequire: () => ClientReferenceRequire | undefined;
  onPreloadError?: (id: string, error: unknown) => void;
};

type ClientReferencePreloader = {
  preload: (referenceIds?: Iterable<string>) => Promise<void>;
};

const resolvedPreload = Promise.resolve();

export function createClientReferencePreloader(
  options: ClientReferencePreloaderOptions,
): ClientReferencePreloader {
  let allReferencesPreloaded = false;
  let allReferencesPreloadPromise: Promise<void> | null = null;
  const preloadedReferences = new Set<string>();
  const referencePreloadPromises = new Map<string, Promise<void>>();

  function preloadReference(id: string, clientRequire: ClientReferenceRequire): Promise<void> {
    if (preloadedReferences.has(id)) {
      return resolvedPreload;
    }

    const existing = referencePreloadPromises.get(id);
    if (existing) {
      return existing;
    }

    const preloadPromise = clientRequire(id)
      .catch((error) => {
        options.onPreloadError?.(id, error);
      })
      .then(() => {
        preloadedReferences.add(id);
      })
      .finally(() => {
        referencePreloadPromises.delete(id);
      });

    referencePreloadPromises.set(id, preloadPromise);
    return preloadPromise;
  }

  function preloadReferenceSet(
    referenceIds: Iterable<string>,
    refs: ClientReferenceMap,
    clientRequire: ClientReferenceRequire,
  ): Promise<void> {
    const pending: Promise<void>[] = [];

    for (const id of referenceIds) {
      if (Object.hasOwn(refs, id)) {
        pending.push(preloadReference(id, clientRequire));
      }
    }

    if (pending.length === 0) {
      return resolvedPreload;
    }

    return Promise.all(pending).then(() => {});
  }

  return {
    preload(referenceIds) {
      const refs = options.getReferences();
      const clientRequire = options.getClientRequire();
      if (!refs || !clientRequire) {
        return resolvedPreload;
      }

      if (referenceIds) {
        return preloadReferenceSet(referenceIds, refs, clientRequire);
      }

      if (allReferencesPreloaded) {
        return resolvedPreload;
      }
      if (allReferencesPreloadPromise) {
        return allReferencesPreloadPromise;
      }

      allReferencesPreloadPromise = preloadReferenceSet(Object.keys(refs), refs, clientRequire)
        .then(() => {
          allReferencesPreloaded = true;
        })
        .finally(() => {
          allReferencesPreloadPromise = null;
        });

      return allReferencesPreloadPromise;
    },
  };
}

const IMPORT_ROW_TAG_BYTE = 73; // I

// The export name of vinext's preload-hint component
// (shims/dynamic-preload-chunks.tsx); its reference key comes from the build.
const DYNAMIC_PRELOAD_CHUNKS_EXPORT_NAME = "DynamicPreloadChunks";

const importRowDecoder = new TextDecoder();

type ImportRow = { referenceId: string; exportName: string };

function parseImportRow(row: Uint8Array): ImportRow | null {
  try {
    const metadata: unknown = JSON.parse(importRowDecoder.decode(row));
    if (!Array.isArray(metadata) || typeof metadata[0] !== "string") return null;
    return {
      referenceId: metadata[0],
      exportName: typeof metadata[2] === "string" ? metadata[2] : "",
    };
  } catch {
    return null;
  }
}

type NamedReferences = { referenceIds: string[]; awaitedReferenceIds: string[] };

/**
 * Start loading each client reference as the Flight stream first names it,
 * ahead of React's Flight client and outside the render.
 *
 * plugin-rsc's SSR loader registers a client module's stylesheets with React
 * the moment its load starts. Started by the Flight client, inside the
 * render, that registration lands in the request before the tree renders, and
 * React keeps the first registration of an href: a `next/dynamic` boundary's
 * own stylesheet link for the same file, with the request nonce, then renders
 * to nothing. Started here, the registration is a no-op, as it was under the
 * startup preload, and the stylesheets register when the component renders.
 *
 * A chunk is forwarded at once, so a boundary whose client module is still
 * loading streams its fallback. The one exception is a chunk naming vinext's
 * own `DynamicPreloadChunks` reference (`dynamicPreloadChunksReferenceId`, as
 * the build keyed it): it waits for that small module, so a boundary's
 * stylesheet link renders ahead of the component it describes rather than
 * after whichever module loaded first.
 */
export function loadClientReferencesAheadOfReact(
  stream: ReadableStream<Uint8Array>,
  preload: (referenceIds: readonly string[]) => Promise<void>,
  dynamicPreloadChunksReferenceId: string | undefined,
): ReadableStream<Uint8Array> {
  // Bytes of an import row, or of a row whose tag has not arrived, cut off by
  // a chunk boundary. Any other row is skipped without being carried, so a
  // chunk is never copied or rescanned because of a row longer than it.
  let carry: Uint8Array | null = null;
  let rawBytesRemaining = 0;
  let inPlainRow = false;
  let passThrough = false;

  function isDynamicPreloadChunks(row: ImportRow): boolean {
    return (
      row.referenceId === dynamicPreloadChunksReferenceId &&
      row.exportName === DYNAMIC_PRELOAD_CHUNKS_EXPORT_NAME
    );
  }

  function scan(chunk: Uint8Array): NamedReferences {
    const named: NamedReferences = { referenceIds: [], awaitedReferenceIds: [] };
    let bytes = chunk;
    let offset = 0;
    if (inPlainRow) {
      const newline = indexOfByte(chunk, NEWLINE_BYTE, 0);
      if (newline === -1) return named;
      inPlainRow = false;
      offset = newline + 1;
    } else if (carry !== null) {
      bytes = concatBytes(carry, chunk);
      carry = null;
    }

    const byteLength = bytes.byteLength;
    while (offset < byteLength) {
      if (rawBytesRemaining > 0) {
        const length = Math.min(rawBytesRemaining, byteLength - offset);
        rawBytesRemaining -= length;
        offset += length;
        continue;
      }

      const colon = indexOfByte(bytes, COLON_BYTE, offset);
      if (colon === -1 || colon + 1 === byteLength) break;

      const tagByte = bytes[colon + 1];
      if (isLengthPrefixedRowTag(tagByte)) {
        const comma = indexOfByte(bytes, COMMA_BYTE, colon + 2);
        if (comma === -1) break;
        const length = parseHexBytes(bytes, colon + 2, comma);
        if (length === null) {
          passThrough = true;
          return named;
        }
        rawBytesRemaining = length;
        offset = comma + 1;
        continue;
      }

      if (!isNewlineFramedRowTag(tagByte) && !isUntaggedJsonRowStart(tagByte)) {
        // Unknown tags may be length-prefixed in a newer React release.
        passThrough = true;
        return named;
      }

      const newline = indexOfByte(bytes, NEWLINE_BYTE, colon + 2);
      if (newline === -1) {
        if (tagByte === IMPORT_ROW_TAG_BYTE) break;
        inPlainRow = true;
        return named;
      }
      if (tagByte === IMPORT_ROW_TAG_BYTE) {
        const row = parseImportRow(bytes.subarray(colon + 2, newline));
        if (row !== null) {
          (isDynamicPreloadChunks(row) ? named.awaitedReferenceIds : named.referenceIds).push(
            row.referenceId,
          );
        }
      }
      offset = newline + 1;
    }

    if (offset < byteLength) carry = bytes.slice(offset);
    return named;
  }

  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      async transform(chunk, controller) {
        if (!passThrough) {
          const { referenceIds, awaitedReferenceIds } = scan(chunk);
          if (referenceIds.length > 0) void preload(referenceIds);
          if (awaitedReferenceIds.length > 0) await preload(awaitedReferenceIds);
        }
        controller.enqueue(chunk);
      },
    }),
  );
}
