/**
 * The barrel entry of an optimized package is picked from `exports["."]` in the
 * package's own key order, as Node, Vite, webpack and Turbopack do. lucide-react
 * 1.x lists `module` (ESM) before `node` (CommonJS), so its ESM barrel must be
 * analyzed and the import rewritten.
 */
import { describe, it, expect } from "vite-plus/test";
import path from "node:path";
import type { Plugin } from "vite-plus";
import { createOptimizeImportsPlugin } from "../packages/vinext/src/plugins/optimize-imports.js";
import { toSlash } from "pathslash";

const FIXTURE_ROOT = toSlash(
  path.resolve(import.meta.dirname, "fixtures/optimize-imports-node-cjs"),
);

function unwrapHook(hook: any): ((...args: any[]) => any) | undefined {
  return typeof hook === "function" ? hook : hook?.handler;
}

async function transformImport(packageName: string, envName: string) {
  const plugin = createOptimizeImportsPlugin(
    () => ({ optimizePackageImports: [packageName] }) as any,
    () => FIXTURE_ROOT,
  ) as Plugin;
  await unwrapHook((plugin as any).buildStart)?.call(plugin);

  const transform = unwrapHook(plugin.transform)!;
  const result = await transform.call(
    { ...plugin, environment: { name: envName } },
    `import { Monitor } from "${packageName}";\nexport default Monitor;`,
    path.posix.join(FIXTURE_ROOT, "app/page.tsx"),
  );
  return result?.code ?? "<import left unchanged>";
}

describe("optimize-imports barrel entry with a CJS `node` export condition", () => {
  for (const envName of ["rsc", "ssr"]) {
    it(`rewrites the barrel import to the ESM icon module when \`module\` comes first (${envName})`, async () => {
      const code = await transformImport("node-cjs-icons", envName);
      expect(code).toContain(
        path.posix.join(FIXTURE_ROOT, "node_modules/node-cjs-icons/dist/esm/icons/monitor.mjs"),
      );
      expect(code).not.toContain(`from "node-cjs-icons"`);
    });

    it(`keeps the barrel import when \`node\` comes first (${envName})`, async () => {
      // Next.js resolves this package to its CommonJS build too, so there is
      // no ESM barrel to analyze and the import stays as written.
      const code = await transformImport("node-first-icons", envName);
      expect(code).toBe("<import left unchanged>");
    });
  }
});
