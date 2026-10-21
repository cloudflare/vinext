import fs from "node:fs";
import path from "pathslash";
import type { ESTree } from "vite";
import { parseProgram, walkAst } from "../plugins/ast-utils.js";

type AsyncModuleGraphInfo = { code: string | null; importedIds: readonly string[] };

/** A chunk of the emitted output, as `renderChunk`'s `meta.chunks` lists it. */
export type EmittedChunk = {
  fileName: string;
  /** The chunks it imports statically, by file name, and its externals. */
  imports: readonly string[];
  /** Its modules, with their code after tree-shaking. */
  modules: Readonly<Record<string, { code: string | null; renderedLength: number }>>;
};

/**
 * Whether `code` awaits at the top level of the module: an `await`, a
 * `for await` or an `await using` outside any function. Code that fails to
 * parse counts as synchronous.
 */
export function hasTopLevelAwait(code: string): boolean {
  if (!code.includes("await")) return false;
  let program: ESTree.Program;
  try {
    program = parseProgram(code, { sourceType: "module" });
  } catch {
    return false;
  }
  let found = false;
  walkAst(program, (node) => {
    if (found) return false;
    if (
      node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression"
    ) {
      return false;
    }
    if (node.type === "AwaitExpression") {
      found = true;
      return false;
    }
    if (
      (node.type === "ForOfStatement" && node.await) ||
      (node.type === "VariableDeclaration" && node.kind === "await using")
    ) {
      found = true;
    }
  });
  return found;
}

/**
 * The `roots` whose evaluation is asynchronous in the emitted output: the
 * module, or a module it imports at any depth, awaits at its top level. Webpack
 * calls these async modules, and React's Flight client suspends on them as they
 * load. Only what the output keeps counts: modules tree-shaking dropped don't
 * make a module async. Neither do imports of a module in a chunk the
 * importer's chunks never load, nor of one `declaresSideEffects` reports, which
 * the output drops when unused. Other imports stay: the imported module's side
 * effects, its await included, run before the importer.
 */
export function collectAsyncModules(options: {
  roots: readonly string[];
  getModuleInfo: (id: string) => AsyncModuleGraphInfo | null;
  chunks: readonly EmittedChunk[];
  declaresSideEffects?: (id: string) => boolean;
}): Set<string> {
  const chunkOf = new Map<string, EmittedChunk>();
  for (const chunk of options.chunks) {
    for (const [id, module] of Object.entries(chunk.modules)) {
      if (module.renderedLength > 0) chunkOf.set(id, chunk);
    }
  }
  const chunksByFile = new Map(options.chunks.map((chunk) => [chunk.fileName, chunk]));
  // The chunks a chunk evaluates after: itself and its static imports, at any depth.
  const loadedChunks = new Map<EmittedChunk, Set<string>>();
  const chunksLoadedWith = (chunk: EmittedChunk) => {
    let files = loadedChunks.get(chunk);
    if (files) return files;
    files = new Set([chunk.fileName]);
    const queue = [chunk];
    for (let index = 0; index < queue.length; index++) {
      for (const file of queue[index]!.imports) {
        const imported = chunksByFile.get(file);
        if (!imported || files.has(file)) continue;
        files.add(file);
        queue.push(imported);
      }
    }
    loadedChunks.set(chunk, files);
    return files;
  };

  const importers = new Map<string, string[]>();
  const awaiting: string[] = [];
  const visited = new Set<string>();
  const stack = options.roots.filter((id) => chunkOf.has(id));
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const chunk = chunkOf.get(id)!;
    const info = options.getModuleInfo(id);
    const code = chunk.modules[id]!.code ?? info?.code ?? null;
    if (code !== null && hasTopLevelAwait(code)) awaiting.push(id);
    const loaded = chunksLoadedWith(chunk);
    for (const imported of info?.importedIds ?? []) {
      const importedChunk = chunkOf.get(imported);
      if (!importedChunk || !loaded.has(importedChunk.fileName)) continue;
      if (options.declaresSideEffects?.(imported)) continue;
      let list = importers.get(imported);
      if (!list) importers.set(imported, (list = []));
      list.push(id);
      stack.push(imported);
    }
  }
  const asyncModules = new Set(awaiting);
  for (let index = 0; index < awaiting.length; index++) {
    for (const importer of importers.get(awaiting[index]!) ?? []) {
      if (asyncModules.has(importer)) continue;
      asyncModules.add(importer);
      awaiting.push(importer);
    }
  }
  return new Set(options.roots.filter((id) => asyncModules.has(id)));
}

/**
 * Whether a module's package declares which of its modules have side effects
 * (`sideEffects` other than `true` in the nearest package.json naming a
 * package or declaring it). A bundler drops an unused import of a module the
 * declaration marks side-effect-free, which Rolldown's module info doesn't
 * report, so an import into such a package may not survive.
 */
export function createSideEffectsDeclarationCheck(): (id: string) => boolean {
  const byDirectory = new Map<string, boolean>();
  const declares = (directory: string): boolean => {
    const cached = byDirectory.get(directory);
    if (cached !== undefined) return cached;
    let pkg: { name?: unknown; sideEffects?: unknown } | undefined;
    try {
      pkg = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"));
    } catch {
      pkg = undefined;
    }
    let result: boolean;
    if (pkg && typeof pkg === "object" && ("sideEffects" in pkg || "name" in pkg)) {
      result = "sideEffects" in pkg && pkg.sideEffects !== true;
    } else {
      const parent = path.dirname(directory);
      result = parent !== directory && declares(parent);
    }
    byDirectory.set(directory, result);
    return result;
  };
  return (id) => {
    const file = id.split("?")[0]!;
    return !id.startsWith("\0") && path.isAbsolute(file) && declares(path.dirname(file));
  };
}
