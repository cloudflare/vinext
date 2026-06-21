import fsp from "node:fs/promises";
import { createRequire } from "node:module";
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

describe("styled-jsx production build", () => {
  it.each([
    { name: "node", plugins: [] },
    { name: "cloudflare", plugins: [{ name: "vite-plugin-cloudflare" }] },
    { name: "nitro", plugins: [{ name: "nitro" }] },
  ])(
    "resolves bundled root and css imports for $name",
    async ({ plugins }) => {
      // Ported from Next.js: test/e2e/app-dir/use-server-inserted-html/app/root-style-registry.js
      // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/use-server-inserted-html/app/root-style-registry.js
      const fixtureRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-styled-jsx-build-"));
      try {
        await fsp.symlink(ROOT_NODE_MODULES, path.join(fixtureRoot, "node_modules"), "junction");
        await writeFile(
          path.join(fixtureRoot, "package.json"),
          `${JSON.stringify({ type: "module", dependencies: {} }, null, 2)}\n`,
        );
        const fixtureRequire = createRequire(path.join(fixtureRoot, "package.json"));
        expect(() => fixtureRequire.resolve("styled-jsx")).toThrow();
        expect(() => fixtureRequire.resolve("styled-jsx/css")).toThrow();
        expect(() => fixtureRequire.resolve("styled-jsx/macro")).toThrow();

        await writeFile(
          path.join(fixtureRoot, "app", "layout.tsx"),
          `export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html><body>{children}</body></html>;
}
`,
        );
        await writeFile(
          path.join(fixtureRoot, "app", "styled.tsx"),
          `"use client";

import { createStyleRegistry } from "styled-jsx";
import css from "styled-jsx/css";

const registry = createStyleRegistry();
const externalStyles = css\`button { color: hotpink; }\`;

export function Styled() {
  return (
    <>
      <style jsx>{\`h1 { color: purple; }\`}</style>
      <style jsx>{externalStyles}</style>
      <h1 data-registry={typeof registry.styles}>styled-jsx</h1>
    </>
  );
}
`,
        );
        await writeFile(
          path.join(fixtureRoot, "app", "page.tsx"),
          `import { Styled } from "./styled";

export default function Page() {
  return <Styled />;
}
`,
        );

        const builder = await createBuilder({
          root: fixtureRoot,
          configFile: false,
          plugins: [...plugins, vinext({ appDir: fixtureRoot })],
          logLevel: "silent",
        });
        await builder.buildApp();

        const chunkDir = path.join(fixtureRoot, "dist", "client", "_next", "static", "chunks");
        const output = (
          await Promise.all(
            (
              await fsp.readdir(chunkDir)
            )
              .filter((file) => file.endsWith(".js"))
              .map((file) => fsp.readFile(path.join(chunkDir, file), "utf8")),
          )
        ).join("\n");

        expect(output).toContain("hotpink");
        expect(output).toContain("purple");
      } finally {
        await fsp.rm(fixtureRoot, { recursive: true, force: true }).catch(() => {});
      }
    },
    120_000,
  );
});
