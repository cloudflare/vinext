import type { Plugin } from "vite";

/**
 * Strip type-only React imports that lack the `type` keyword.
 *
 * esbuild (Vite's default TS transform) can't determine whether an import
 * like `import { ReactNode } from "react"` is type-only without TS type
 * information. It preserves the import, and Vite's module runner then fails
 * with "Named export 'ReactNode' not found" because `react` is CJS and
 * the pre-bundled ESM version only has runtime exports.
 *
 * This plugin knows the complete set of React runtime exports and strips
 * any import name that isn't in that set from `import { ... } from "react"`
 * statements.
 */
export function stripReactTypeImports(): Plugin {
  // React runtime exports (everything else is a TypeScript type)
  const REACT_RUNTIME_EXPORTS = new Set([
    "Children", "Component", "Fragment", "Profiler", "PureComponent",
    "StrictMode", "Suspense", "act", "cache", "cloneElement", "createContext",
    "createElement", "createRef", "forwardRef", "isValidElement", "lazy",
    "memo", "startTransition", "use", "useActionState", "useCallback",
    "useContext", "useDebugValue", "useDeferredValue", "useEffect", "useId",
    "useImperativeHandle", "useInsertionEffect", "useLayoutEffect", "useMemo",
    "useOptimistic", "useReducer", "useRef", "useState", "useSyncExternalStore",
    "useTransition", "version",
    // Internal (used by some libraries)
    "__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE",
    "unstable_useCacheRefresh",
  ]);

  const RE = /import\s+\{([^}]+)\}\s*from\s*['"]react['"]/g;

  return {
    name: "vinext:strip-react-type-imports",
    enforce: "pre",
    transform(code, _id) {
      if (!code.includes("from 'react'") && !code.includes('from "react"')) return;
      if (!RE.test(code)) return;
      RE.lastIndex = 0;

      let changed = false;
      const result = code.replace(RE, (match, names: string) => {
        // Skip `import type { ... } from "react"`
        if (/import\s+type\s*\{/.test(match)) return match;

        const entries = names.split(",").map((e) => e.trim()).filter(Boolean);
        const runtimeEntries = entries.filter((e) => {
          if (e.startsWith("type ")) return false; // inline type annotation
          const name = e.includes(" as ") ? e.split(" as ")[0].trim() : e;
          return REACT_RUNTIME_EXPORTS.has(name);
        });

        if (runtimeEntries.length === entries.length) return match; // all runtime, no change
        if (runtimeEntries.length === 0) {
          changed = true;
          return `/* stripped type-only react import */`;
        }

        changed = true;
        return `import { ${runtimeEntries.join(", ")} } from 'react'`;
      });

      return changed ? result : undefined;
    },
  };
}
