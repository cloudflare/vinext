import type { Plugin } from "vite";
import { normalizePath, parseAst } from "vite";
import MagicString from "magic-string";
import { stripViteModuleQuery } from "../utils/path.js";
import { magicStringTransformResult } from "./transform-result.js";

function insertionPositionAfterDirectives(code: string): number {
  const ast = parseAst(code);
  let insertPos = 0;
  for (const node of ast.body) {
    if (node.type !== "ExpressionStatement" || node.directive === undefined) break;
    insertPos = node.end;
  }
  return insertPos;
}

export function createInstrumentationServerTransformPlugin(
  getInstrumentationPath: () => string | null,
  getValues: () => Record<string, unknown>,
): Plugin {
  return {
    name: "vinext:instrumentation-server-values",
    applyToEnvironment(environment) {
      return environment.name !== "client";
    },
    transform(code, id) {
      const instrumentationPath = getInstrumentationPath();
      if (!instrumentationPath) return null;
      if (normalizePath(stripViteModuleQuery(id)) !== instrumentationPath) return null;

      const entries = Object.entries(getValues());
      if (entries.length === 0 || code.includes("__vinextInstrumentationServerValues")) return null;
      const assignments = entries
        .map(([key, value]) => {
          const serialized = JSON.stringify(value);
          return `globalThis[${JSON.stringify(key)}] = ${serialized ?? "undefined"};`;
        })
        .join("\n");
      const s = new MagicString(code);
      s.appendLeft(
        insertionPositionAfterDirectives(code),
        `\n/* __vinextInstrumentationServerValues */\n${assignments}\n`,
      );
      return magicStringTransformResult(s, { hires: true });
    },
  };
}

export function createInstrumentationClientTransformPlugin(
  getInstrumentationClientPath: () => string | null,
  getRouteManifest: () => string | undefined,
): Plugin {
  let isDev = false;
  return {
    name: "vinext:instrumentation-client",
    configResolved(config) {
      isDev = config.command === "serve";
    },
    transform(code, id) {
      const instrumentationClientPath = getInstrumentationClientPath();
      if (!instrumentationClientPath) return null;

      // findInstrumentationClientFile already returns a POSIX path, so only the
      // incoming id needs normalizing before the comparison.
      const normalizedId = normalizePath(stripViteModuleQuery(id));
      if (normalizedId !== instrumentationClientPath) return null;

      const routeManifest = getRouteManifest();
      const shouldInjectManifest =
        routeManifest !== undefined && !code.includes('globalThis["_sentryRouteManifest"]');
      const shouldInjectDevTimer = isDev && !code.includes("__vinextInstrumentationClientStart");
      if (!shouldInjectManifest && !shouldInjectDevTimer) return null;

      const insertPos = insertionPositionAfterDirectives(code);

      const s = new MagicString(code);
      const preamble = [
        shouldInjectManifest
          ? `globalThis["_sentryRouteManifest"] = ${JSON.stringify(routeManifest)};`
          : "",
        shouldInjectDevTimer ? "const __vinextInstrumentationClientStart = performance.now();" : "",
      ]
        .filter(Boolean)
        .join("\n");
      s.appendLeft(insertPos, `\n${preamble}\n`);
      if (shouldInjectDevTimer) {
        s.append(
          "\nconst __vinextInstrumentationClientEnd = performance.now();\n" +
            "const __vinextInstrumentationClientDuration = __vinextInstrumentationClientEnd - __vinextInstrumentationClientStart;\n" +
            "// Match Next.js: only report slow client instrumentation during dev.\n" +
            "// Production should execute the hook without additional timing overhead.\n" +
            "if (__vinextInstrumentationClientDuration > 16) {\n" +
            "  console.log(`[Client Instrumentation Hook] Slow execution detected: ${__vinextInstrumentationClientDuration.toFixed(0)}ms (Note: Code download overhead is not included in this measurement)`);\n" +
            "}\n",
        );
      }

      return magicStringTransformResult(s, { hires: true });
    },
  };
}
