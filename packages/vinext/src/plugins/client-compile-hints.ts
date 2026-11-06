import type { Plugin } from "vite";

/**
 * V8's file-level explicit compile hint (Chrome 136+). V8 compiles every
 * function in a file that starts with this comment eagerly, on the background
 * thread that streams the script, instead of lazily on the main thread the
 * first time each function runs. Other engines ignore it.
 * https://v8.dev/blog/explicit-compile-hints
 */
export const CLIENT_COMPILE_HINT = "//# allFunctionsCalledOnLoad";

type SourceMapLike = { mappings: string };

/** Shifts a sourcemap down one generated line, for a line added at the top. */
function shiftSourceMapSource(source: string | Uint8Array): string {
  const text = typeof source === "string" ? source : new TextDecoder().decode(source);
  const map = JSON.parse(text) as SourceMapLike;
  map.mappings = ";" + map.mappings;
  return JSON.stringify(map);
}

/**
 * Marks the client chunks every page load runs with V8's compile hint.
 *
 * Those are the browser entry chunks and the chunks they import statically:
 * React, React DOM, the Flight client and the vinext runtime. Hydration calls
 * most of their functions on load, so lazy compilation only moves that work
 * onto the main thread. Chunks reached through dynamic imports (route code,
 * lazy client references, navigation-only modules) keep lazy compilation,
 * since eagerly compiling code a page may never call costs time and memory.
 *
 * The hint has to be the first line of the file, so it is added in the last
 * generateBundle pass, after minification and after Vite's import analysis
 * prepends its `__vite__mapDeps` preload helper. That pass runs after Rolldown
 * hashes file names, so `augmentChunkHash` salts the hash of every chunk that
 * gets the hint: a hinted file never reuses the URL of an unhinted one, which
 * browsers may hold as immutable. Its sourcemap keeps following the chunk's
 * name, so builds that name sourcemaps themselves are left alone.
 */
export function createClientCompileHintsPlugin(isBrowserEntry: (id: string) => boolean): Plugin {
  // Preliminary file names of the startup chunks, once the first renderChunk
  // call has seen the chunk graph; null until then. Keyed by environment:
  // Vite shares plugin instances across environments.
  const startupByEnvironment = new WeakMap<object, { chunks: Set<string> | null }>();
  const startupChunks = (environment: object | undefined) =>
    (environment && startupByEnvironment.get(environment)?.chunks) ?? undefined;

  return {
    name: "vinext:client-compile-hints",
    apply: "build",
    enforce: "post",

    renderStart(outputOptions) {
      const environment = this.environment;
      if (environment?.name !== "client") return;
      const { codeSplitting, sourcemap, sourcemapFileNames } = outputOptions;
      // Without code splitting the entry inlines every dynamic import, so the
      // hint would compile route code a page may never run. A data-URL
      // sourcemap would need re-encoding to account for the added line, and a
      // sourcemap named by its own pattern may not change name with its chunk.
      if (
        !codeSplitting ||
        sourcemap === "inline" ||
        (sourcemap && sourcemapFileNames !== undefined)
      ) {
        startupByEnvironment.delete(environment);
        return;
      }
      startupByEnvironment.set(environment, { chunks: null });
    },

    renderChunk(_code, _chunk, _options, meta) {
      const state = this.environment && startupByEnvironment.get(this.environment);
      if (!state || state.chunks) return null;
      const startup = new Set<string>();
      const pending: string[] = [];
      for (const chunk of Object.values(meta.chunks)) {
        if (
          chunk.isEntry &&
          chunk.facadeModuleId !== null &&
          isBrowserEntry(chunk.facadeModuleId)
        ) {
          pending.push(chunk.fileName);
        }
      }
      for (let fileName = pending.pop(); fileName !== undefined; fileName = pending.pop()) {
        const chunk = meta.chunks[fileName];
        if (startup.has(fileName) || !chunk) continue;
        startup.add(fileName);
        // `imports` lists static imports only; dynamic imports stay lazy.
        pending.push(...chunk.imports);
      }
      state.chunks = startup;
      return null;
    },

    augmentChunkHash(chunk) {
      if (startupChunks(this.environment)?.has(chunk.fileName)) return CLIENT_COMPILE_HINT;
    },

    generateBundle: {
      order: "post",
      handler(options, bundle) {
        const startup = startupChunks(this.environment);
        if (!startup) return;
        for (const chunk of Object.values(bundle)) {
          if (chunk.type !== "chunk" || !startup.has(chunk.preliminaryFileName)) continue;
          chunk.code = `${CLIENT_COMPILE_HINT}\n${chunk.code}`;
          if (!options.sourcemap) continue;
          if (chunk.map) chunk.map.mappings = ";" + chunk.map.mappings;
          const mapAsset = chunk.sourcemapFileName ? bundle[chunk.sourcemapFileName] : undefined;
          if (mapAsset?.type === "asset") mapAsset.source = shiftSourceMapSource(mapAsset.source);
        }
      },
    },
  };
}
