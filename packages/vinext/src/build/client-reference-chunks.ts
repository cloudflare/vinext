import type { ResolvedConfig, Rollup } from "vite";
import { toManifestModuleId } from "../plugins/dynamic-preload-metadata.js";
import {
  RESOLVED_CLIENT_REFERENCE_CHUNKS_ID,
  RESOLVED_CLIENT_REFERENCE_MODULE_PREFIX,
} from "../plugins/rsc-client-reference-loaders.js";
import type { ClientReferenceChunks } from "../utils/client-reference-chunks.js";

/** As Vite's preload helper tells a stylesheet: by its URL's path. */
function isStylesheet(file: string): boolean {
  return new URL(file, "http://vinext.local/").pathname.endsWith(".css");
}

/**
 * Collect what each App Router client reference loads in the browser from the
 * client bundle: the chunk holding the module that registers it (see
 * plugins/rsc-client-reference-loaders.ts), and the JS chunks and stylesheets
 * that chunk needs, as Vite's preload helper would load them for a dynamic
 * import. JS chunks the App browser entry imports statically have loaded
 * before any Flight row decodes, so they are left out.
 *
 * @param moduleKeys Client reference modules by resolved id, with the keys of
 *   the references each registers.
 * @param modulePreload The client build's `build.modulePreload`, which picks
 *   the JS chunks to modulepreload, as it does for Vite's preload helper. Its
 *   `resolveDependencies` sees the chunk that dynamically imports each
 *   registering module as the host, as Vite passes it.
 */
export function collectClientReferenceChunks(
  bundle: Rollup.OutputBundle,
  moduleKeys: ReadonlyMap<string, readonly string[]>,
  appBrowserEntry: Rollup.OutputChunk | undefined,
  modulePreload?: ResolvedConfig["build"]["modulePreload"],
): ClientReferenceChunks | undefined {
  const chunks = new Map<string, Rollup.OutputChunk>();
  let host: Rollup.OutputChunk | undefined;
  for (const output of Object.values(bundle)) {
    if (output.type !== "chunk") continue;
    chunks.set(output.fileName, output);
    if (output.facadeModuleId === RESOLVED_CLIENT_REFERENCE_CHUNKS_ID) host = output;
  }
  const staticImports = (chunk: Rollup.OutputChunk): Rollup.OutputChunk[] => {
    const seen = new Set<string>([chunk.fileName]);
    const order = [chunk];
    for (let i = 0; i < order.length; i++) {
      for (const file of order[i]!.imports) {
        const imported = chunks.get(file);
        if (!imported || seen.has(file)) continue;
        seen.add(file);
        order.push(imported);
      }
    }
    return order;
  };
  const eager = new Set(
    appBrowserEntry ? staticImports(appBrowserEntry).map((chunk) => chunk.fileName) : [],
  );

  const result: ClientReferenceChunks = { references: {}, modules: [] };
  for (const chunk of chunks.values()) {
    const keys = chunk.moduleIds.flatMap((moduleId) => moduleKeys.get(moduleId) ?? []);
    if (keys.length === 0) continue;
    const imports: string[] = [];
    const css = new Set<string>();
    // As in Vite's preload helper, a chunk's imports come before its own
    // stylesheets, so stylesheets load in import order.
    const visited = new Set<string>();
    const addDeps = (loaded: Rollup.OutputChunk) => {
      if (visited.has(loaded.fileName)) return;
      visited.add(loaded.fileName);
      if (loaded !== chunk) imports.push(loaded.fileName);
      for (const file of loaded.imports) {
        const imported = chunks.get(file);
        if (imported) addDeps(imported);
      }
      for (const file of loaded.viteMetadata?.importedCss ?? []) css.add(file);
    };
    addDeps(chunk);
    // As in Vite, a chunk that needs anything else preloads with its
    // dependencies, and `build.modulePreload` picks the JS among them. A
    // stylesheet `resolveDependencies` adds is linked before the chunk's own.
    let preloads = imports.length + css.size > 0 ? [chunk.fileName, ...imports] : [];
    let stylesheets = [...css];
    if (modulePreload === false) {
      preloads = [];
    } else if (modulePreload?.resolveDependencies && host) {
      const resolved = modulePreload.resolveDependencies(chunk.fileName, preloads, {
        hostId: host.fileName,
        hostType: "js",
      });
      preloads = resolved.filter((file) => !isStylesheet(file));
      stylesheets = [...new Set([...resolved.filter(isStylesheet), ...css])];
    }
    // The browser entry's static imports have loaded before any Flight row
    // decodes. The loader imports the chunk once its stylesheets load, so
    // preloading it only helps while it waits for them.
    preloads = [...new Set(preloads)].filter(
      (file) => !eager.has(file) && (file !== chunk.fileName || stylesheets.length > 0),
    );
    const index =
      result.modules.push({ file: chunk.fileName, imports: preloads, css: stylesheets }) - 1;
    for (const key of keys) result.references[key] = index;
  }
  return result.modules.length > 0 ? result : undefined;
}

/**
 * Vite's build manifest keys a dynamic import by the module it imports, and
 * next/dynamic's SSR preloads look up the module a boundary imports (see
 * shims/dynamic-preload-chunks.tsx). The client build imports a client
 * reference outside every group through the module that registers it, not
 * the reference's own module, so map the reference's module to the chunk of
 * the module that registers it, keyed as Vite keys a manifest entry.
 *
 * @param getImportedIds A module's static imports, as the bundler resolved
 *   them.
 */
export function collectClientReferenceSources(
  bundle: Rollup.OutputBundle,
  getImportedIds: (moduleId: string) => readonly string[] | undefined,
  root: string,
): Record<string, string> | undefined {
  const sources: Record<string, string> = {};
  for (const output of Object.values(bundle)) {
    if (output.type !== "chunk") continue;
    for (const moduleId of output.moduleIds) {
      if (!moduleId.startsWith(RESOLVED_CLIENT_REFERENCE_MODULE_PREFIX)) continue;
      // The reference's module is the registering module's last import.
      const source = getImportedIds(moduleId)?.at(-1);
      if (source === undefined || source.startsWith("\0")) continue;
      // Keyed as next/dynamic's metadata keys the module it looks up.
      const key = toManifestModuleId(root, source);
      if (key) sources[key] = output.fileName;
    }
  }
  return Object.keys(sources).length > 0 ? sources : undefined;
}
