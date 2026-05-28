import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createBuilder } from "vite";
import { describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";

const ROOT_NODE_MODULES = path.resolve(import.meta.dirname, "../node_modules");

async function writeFile(file: string, source: string): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, source, "utf8");
}

async function findRscEntry(rscOutDir: string): Promise<string> {
  const entries = await fsp.readdir(rscOutDir);
  const entry = entries.find((file) => /^index\.m?js$/.test(file));
  if (!entry) {
    throw new Error(`No RSC entry found in ${rscOutDir}. Contents: ${entries.join(", ")}`);
  }
  return path.join(rscOutDir, entry);
}

describe("inline CSS production build", () => {
  it("injects the inline CSS manifest into a custom App Router RSC output directory", async () => {
    const fixtureRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-inline-css-build-"));
    const outRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-inline-css-build-out-"));
    try {
      await fsp.symlink(ROOT_NODE_MODULES, path.join(fixtureRoot, "node_modules"), "junction");
      await writeFile(
        path.join(fixtureRoot, "package.json"),
        `${JSON.stringify({ type: "module", dependencies: {} }, null, 2)}\n`,
      );
      await writeFile(
        path.join(fixtureRoot, "app", "global.css"),
        ".inline-css-build-marker { color: rgb(1, 2, 3); }\n",
      );
      await writeFile(
        path.join(fixtureRoot, "app", "layout.tsx"),
        `import "./global.css";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html><body>{children}</body></html>;
}
`,
      );
      await writeFile(
        path.join(fixtureRoot, "app", "page.tsx"),
        `export default function Page() {
  return <p className="inline-css-build-marker">home</p>;
}
`,
      );

      const rscOutDir = path.join(outRoot, "custom-rsc");
      const ssrOutDir = path.join(outRoot, "custom-ssr");
      const builder = await createBuilder({
        root: fixtureRoot,
        configFile: false,
        plugins: [
          vinext({
            appDir: fixtureRoot,
            rscOutDir,
            ssrOutDir,
            nextConfig: {
              experimental: {
                inlineCss: true,
              },
            },
          }),
        ],
        logLevel: "silent",
      });

      await builder.buildApp();

      const rscEntry = await findRscEntry(rscOutDir);
      const code = await fsp.readFile(rscEntry, "utf8");

      expect(code).toContain("globalThis.__VINEXT_INLINE_CSS__");
      expect(code).toContain("_next/static");
    } finally {
      await fsp.rm(fixtureRoot, { recursive: true, force: true }).catch(() => {});
      await fsp.rm(outRoot, { recursive: true, force: true }).catch(() => {});
    }
  }, 120_000);
});
