import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "vite";
import { describe, it, expect } from "vitest";

describe("shim JSX runtime compatibility", () => {
  it("loads shim modules when react/jsx-runtime only exposes a default export", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-jsx-runtime-"));
    const jsxRuntimePath = path.join(tmpDir, "jsx-runtime-default-only.mjs");
    const jsxDevRuntimePath = path.join(tmpDir, "jsx-dev-runtime-default-only.mjs");
    const repoRoot = path.resolve(import.meta.dirname, "..");
    const shimPaths = [
      "../packages/vinext/src/shims/link.tsx",
      "../packages/vinext/src/shims/metadata.tsx",
      "../packages/vinext/src/shims/legacy-image.tsx",
      "../packages/vinext/src/shims/form.tsx",
      "../packages/vinext/src/shims/document.tsx",
      "../packages/vinext/src/shims/image.tsx",
    ].map((p) => path.resolve(import.meta.dirname, p));

    await fs.writeFile(
      jsxRuntimePath,
      "const jsx = () => null; const jsxs = () => null; const Fragment = 'div'; export default { jsx, jsxs, Fragment };\n",
    );
    await fs.writeFile(
      jsxDevRuntimePath,
      "const jsxDEV = () => null; const Fragment = 'div'; export default { jsxDEV, Fragment };\n",
    );

    let server: Awaited<ReturnType<typeof createServer>> | undefined;
    try {
      server = await createServer({
        root: repoRoot,
        configFile: false,
        server: { port: 0 },
        logLevel: "silent",
        plugins: [
          {
            name: "vinext:jsx-runtime-default-only-test",
            enforce: "pre",
            resolveId(id) {
              if (id === "react/jsx-runtime") return jsxRuntimePath;
              if (id === "react/jsx-dev-runtime") return jsxDevRuntimePath;
              return null;
            },
          },
        ],
      });

      for (const shimPath of shimPaths) {
        const mod = await server.ssrLoadModule(shimPath);
        expect(Object.keys(mod).length).toBeGreaterThan(0);
      }
    } finally {
      await server?.close();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
