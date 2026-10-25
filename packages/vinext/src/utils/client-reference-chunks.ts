/**
 * The chunks an App Router client reference loads in the browser, which the
 * RSC render names in the reference's Flight row (see
 * server/app-client-reference-manifest.ts).
 */
export type ClientReferenceChunks = {
  /** Reference key -> index into `modules`. */
  references: Record<string, number>;
  /**
   * Each chunk that registers client references (see
   * shims/internal/client-reference-loader.ts), with the JS chunks to
   * modulepreload (it and the chunks it imports that the browser entry
   * doesn't, picked by `build.modulePreload`), and the stylesheets they need.
   */
  modules: { file: string; imports: string[]; css: string[] }[];
};

/**
 * How the browser loads a chunk a Flight row names. React passes the loader
 * only the chunk id, so the id is the kind followed by the URL.
 */
export const CLIENT_REFERENCE_CHUNK_KIND = {
  /**
   * The chunk that registers the reference, imported once the stylesheets
   * its id lists after its URL have loaded.
   */
  module: "m",
  /** A JS chunk to modulepreload: the module chunk, or one it imports. */
  preload: "p",
} as const;

/** Separates the URLs in a module chunk's id. A URL can't hold a raw newline. */
export const CLIENT_REFERENCE_CHUNK_URL_SEPARATOR = "\n";

/**
 * React's webpack Flight binding takes a client reference's chunks as
 * `[chunkId, filename, ...]` pairs. Only the id reaches the browser's chunk
 * loader, so the filenames are left empty. The module chunk's id lists its
 * stylesheets, so the loader can link them before the chunk evaluates, as
 * Vite's preload helper does.
 */
export function toFlightChunks(module: ClientReferenceChunks["modules"][number]): string[] {
  const chunks = [
    CLIENT_REFERENCE_CHUNK_KIND.module +
      [module.file, ...module.css].join(CLIENT_REFERENCE_CHUNK_URL_SEPARATOR),
    "",
  ];
  for (const file of module.imports) chunks.push(CLIENT_REFERENCE_CHUNK_KIND.preload + file, "");
  return chunks;
}
