import type { Plugin } from "vite";
import { normalizePath, parseAst } from "vite";
import MagicString from "magic-string";

export function createInstrumentationClientTransformPlugin(
  getInstrumentationClientPath: () => string | null,
): Plugin {
  return {
    name: "vinext:instrumentation-client",
    apply: "serve",
    transform(code, id) {
      const instrumentationClientPath = getInstrumentationClientPath();
      if (!instrumentationClientPath) return null;

      const normalizedId = normalizePath(id.split("?", 1)[0]);
      if (normalizedId !== normalizePath(instrumentationClientPath)) return null;
      if (code.includes("__vinextInstrumentationClientStart")) return null;

      const ast = parseAst(code);
      let insertPos = 0;
      // When the module has no imports, inject the timer at the top so the
      // measurement still wraps the full module body execution.
      for (const node of ast.body) {
        if (node.type === "ImportDeclaration") {
          insertPos = node.end;
        }
      }

      const s = new MagicString(code);
      s.appendLeft(insertPos, "\nconst __vinextInstrumentationClientStart = performance.now();\n");
      s.append(
        "\nconst __vinextInstrumentationClientEnd = performance.now();\n" +
          "const __vinextInstrumentationClientDuration = __vinextInstrumentationClientEnd - __vinextInstrumentationClientStart;\n" +
          "// Match Next.js: only report slow client instrumentation during dev.\n" +
          "// Production should execute the hook without additional timing overhead.\n" +
          "if (__vinextInstrumentationClientDuration > 16) {\n" +
          "  console.log(`[Client Instrumentation Hook] Slow execution detected: ${__vinextInstrumentationClientDuration.toFixed(0)}ms (Note: Code download overhead is not included in this measurement)`);\n" +
          "}\n",
      );

      return {
        code: s.toString(),
        map: s.generateMap({ hires: true }),
      };
    },
  };
}
