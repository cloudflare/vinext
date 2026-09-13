import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import path from "node:path";
import { createBuilder } from "vite";
import { afterAll, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";
import { startProdServer } from "../packages/vinext/src/server/prod-server.js";

const tempDirs: string[] = [];
const servers: Server[] = [];

function writeFile(root: string, relativePath: string, content: string): void {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function writePackage(
  root: string,
  relativePath: string,
  name: string,
  version: string,
  source: string,
): void {
  writeFile(
    root,
    `${relativePath}/package.json`,
    JSON.stringify({ name, version, type: "module", exports: "./index.js" }),
  );
  writeFile(root, `${relativePath}/index.js`, source);
}

function linkPackage(root: string, packageName: string): void {
  fs.symlinkSync(
    path.join(root, "packages", packageName),
    path.join(root, "node_modules", packageName),
    "junction",
  );
}

async function createFixture(): Promise<string> {
  const root = await mkdtemp(path.join(import.meta.dirname, ".tmp-externals-transitive-"));
  tempDirs.push(root);
  writeFile(root, "package.json", JSON.stringify({ private: true, type: "module" }));
  writeFile(
    root,
    "next.config.mjs",
    `export default { serverExternalPackages: ["shared-version"] };\n`,
  );
  writeFile(
    root,
    "app/layout.tsx",
    `export default function Layout({ children }: { children: React.ReactNode }) {
  return <html><body>{children}</body></html>;
}\n`,
  );
  writeFile(
    root,
    "app/page.tsx",
    `import depA from "dep-a";
import depB from "../node_modules/dep-b/index.js?vinext-transitive";
export default function Page() { return <p>{depA}, {depB}</p>; }\n`,
  );

  writePackage(
    root,
    "node_modules/shared-version",
    "shared-version",
    "3.10.1",
    `export default "3.10.1";\n`,
  );
  writePackage(root, "node_modules/pg", "pg", "8.0.0", `export default "8.0.0";\n`);
  writePackage(
    root,
    "packages/dep-a",
    "dep-a",
    "1.0.0",
    `import version from "shared-version";
import pgVersion from "pg";
export default "depA:" + version + ":pg@" + pgVersion;\n`,
  );
  writePackage(
    root,
    "packages/dep-b",
    "dep-b",
    "1.0.0",
    `import version from "shared-version";
import pgVersion from "pg";
export default "depB:" + version + ":pg@" + pgVersion;\n`,
  );
  writePackage(
    root,
    "packages/dep-b/node_modules/shared-version",
    "shared-version",
    "4.17.21",
    `export default "4.17.21";\n`,
  );
  writePackage(root, "packages/dep-b/node_modules/pg", "pg", "9.0.0", `export default "9.0.0";\n`);
  fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
  linkPackage(root, "dep-a");
  linkPackage(root, "dep-b");
  return root;
}

afterAll(async () => {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    ),
  );
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("transitive server externals", () => {
  // Ported from Next.js: test/e2e/externals-transitive/externals-transitive.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/externals-transitive/externals-transitive.test.ts
  it("preserves the package version selected by each importing dependency", async () => {
    const root = await createFixture();
    const builder = await createBuilder({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [
        vinext({
          appDir: root,
          rscOutDir: path.join(root, "dist/server"),
          ssrOutDir: path.join(root, "dist/server/ssr"),
          clientOutDir: path.join(root, "dist/client"),
        }),
      ],
    });
    await builder.buildApp();

    const started = await startProdServer({
      port: 0,
      host: "127.0.0.1",
      outDir: path.join(root, "dist"),
    });
    servers.push(started.server);
    const address = started.server.address();
    if (!address || typeof address === "string") throw new Error("Server did not bind");

    const response = await fetch(`http://127.0.0.1:${address.port}/`);
    const html = (await response.text()).replaceAll("<!-- -->", "");
    expect(response.status, html).toBe(200);
    expect(html).toContain("depA:3.10.1:pg@8.0.0, depB:4.17.21:pg@9.0.0");
  }, 30_000);
});
