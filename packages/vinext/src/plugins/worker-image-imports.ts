import fs from "node:fs";
import MagicString from "magic-string";
import path, { toSlash } from "pathslash";
import { parseAst, type ESTree, type Plugin } from "vite";
import { appendDeploymentIdQuery } from "../utils/deployment-id.js";
import { NODE_MODULES_PATH_RE, stripViteModuleQuery } from "../utils/path.js";
import { staticStringValue, walkAst } from "./ast-utils.js";
import { magicStringTransformResult } from "./transform-result.js";

const WORKER_IMAGE_METADATA_PREFIX = "\0vinext-worker-image-meta:";
// oxlint-disable-next-line no-control-regex -- null byte prefix is intentional (Vite virtual module convention)
const WORKER_IMAGE_METADATA_RE = /^\0vinext-worker-image-meta:/;
const WORKER_SCRIPT_RE = /\.(?:[cm]?[jt]sx?)$/;
const WORKER_IMAGE_DYNAMIC_IMPORT_RE =
  /import\(\s*["'][^"']+\.(?:png|jpe?g|gif|webp|avif|svg|ico|bmp|tiff?)["']\s*\)/;
const WORKER_IMAGE_EXTENSION_RE = /\.(?:png|jpe?g|gif|webp|avif|svg|ico|bmp|tiff?)$/;

function workerChunkSpecifier(hostFileName: string, targetFileName: string): string {
  const relative = path.relative(path.dirname(hostFileName), targetFileName);
  return relative.startsWith(".") ? relative : `./${relative}`;
}

/**
 * Preserve Next.js's StaticImageData shape for dynamic image imports inside
 * Vite worker graphs. Worker builds use their own plugin container, so the
 * top-level vinext:image-imports plugin cannot perform this transform.
 */
export function createWorkerImageImportsPlugin(options: { deploymentId?: string } = {}): Plugin {
  const dimensionCache = new Map<string, { width: number; height: number }>();

  return {
    name: "vinext:worker-image-imports",
    enforce: "pre",

    watchChange(id) {
      dimensionCache.delete(toSlash(id));
    },

    resolveId: {
      filter: { id: WORKER_IMAGE_METADATA_RE },
      handler(source) {
        return source;
      },
    },

    load: {
      filter: { id: WORKER_IMAGE_METADATA_RE },
      async handler(id) {
        const imagePath = id.slice(WORKER_IMAGE_METADATA_PREFIX.length);
        this.addWatchFile(imagePath);

        let dimensions = dimensionCache.get(imagePath);
        if (!dimensions) {
          try {
            const { imageSize } = await import("image-size");
            const result = imageSize(fs.readFileSync(imagePath));
            dimensions = { width: result.width ?? 0, height: result.height ?? 0 };
          } catch {
            dimensions = { width: 0, height: 0 };
          }
          dimensionCache.set(imagePath, dimensions);
        }

        return `export default ${JSON.stringify(dimensions)};`;
      },
    },

    transform: {
      filter: {
        id: { include: WORKER_SCRIPT_RE, exclude: NODE_MODULES_PATH_RE },
        code: WORKER_IMAGE_DYNAMIC_IMPORT_RE,
      },
      async handler(code, id) {
        const sourceId = toSlash(stripViteModuleQuery(id));
        let ast: ReturnType<typeof parseAst>;
        try {
          ast = parseAst(code, { lang: /\.(?:[cm]?ts)$/.test(sourceId) ? "ts" : "tsx" });
        } catch {
          return null;
        }

        const output = new MagicString(code);
        const imageImports: Array<{
          end: number;
          importPath: string;
          start: number;
        }> = [];

        walkAst(ast, (node) => {
          if (
            node.type === "ImportExpression" &&
            node.source.type === "Literal" &&
            typeof node.source.value === "string" &&
            WORKER_IMAGE_EXTENSION_RE.test(node.source.value)
          ) {
            imageImports.push({
              end: node.end,
              importPath: node.source.value,
              start: node.start,
            });
            return false;
          }
        });
        let changed = false;
        for (const imageImport of imageImports) {
          const resolved = await this.resolve(imageImport.importPath, sourceId, { skipSelf: true });
          const resolvedId = resolved ? stripViteModuleQuery(resolved.id) : undefined;
          const imagePath = resolvedId
            ? toSlash(resolvedId)
            : imageImport.importPath.startsWith(".")
              ? path.resolve(path.dirname(sourceId), imageImport.importPath)
              : null;
          if (!imagePath || !fs.existsSync(imagePath)) continue;

          output.overwrite(
            imageImport.start,
            imageImport.end,
            `Promise.all([import(${JSON.stringify(imageImport.importPath)}), import(${JSON.stringify(
              WORKER_IMAGE_METADATA_PREFIX + imagePath,
            )})]).then(([url, metadata]) => ({ default: { src: url.default, width: metadata.default.width, height: metadata.default.height } }))`,
          );
          changed = true;
        }
        if (!changed) return null;
        return magicStringTransformResult(output);
      },
    },

    renderChunk: {
      order: "pre",
      handler(code, chunk) {
        if (!options.deploymentId) return null;
        const chunkSpecifiers = new Set(
          [...chunk.imports, ...chunk.dynamicImports].map((target) =>
            workerChunkSpecifier(chunk.fileName, target),
          ),
        );
        if (chunkSpecifiers.size === 0) return null;

        let ast: ReturnType<typeof parseAst>;
        try {
          ast = parseAst(code);
        } catch {
          return null;
        }

        const output = new MagicString(code);
        let changed = false;
        walkAst(ast, (node) => {
          const source: ESTree.Node | null =
            node.type === "ImportExpression" ||
            node.type === "ImportDeclaration" ||
            node.type === "ExportNamedDeclaration" ||
            node.type === "ExportAllDeclaration"
              ? node.source
              : null;
          const specifier = staticStringValue(source);
          if (specifier !== null && chunkSpecifiers.has(specifier) && source) {
            output.overwrite(
              source.start,
              source.end,
              JSON.stringify(appendDeploymentIdQuery(specifier, options.deploymentId)),
            );
            changed = true;
            return false;
          }
        });
        if (!changed) return null;
        return magicStringTransformResult(output);
      },
    },
  };
}
