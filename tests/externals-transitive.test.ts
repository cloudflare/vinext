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

function writeFixtureFile(root: string, filePath: string, content: string): void {
  const absolutePath = path.join(root, filePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content);
}

function writePackage(
  root: string,
  packagePath: string,
  version: string,
  source: string,
  packageJson: Record<string, unknown> = {},
): void {
  writeFixtureFile(
    root,
    `${packagePath}/package.json`,
    JSON.stringify({ name: path.basename(packagePath), version, type: "module", ...packageJson }),
  );
  writeFixtureFile(root, `${packagePath}/index.js`, source);
}

function writeConditionalPackage(
  root: string,
  packagePath: string,
  version: string,
  label: string,
): void {
  writePackage(
    root,
    packagePath,
    version,
    `export default ${JSON.stringify(`${label}-import`)};\n`,
    {
      exports: {
        ".": { import: "./index.js", require: "./index.cjs" },
        "./feature": { import: "./feature.js", require: "./feature.cjs" },
        "./package.json": "./package.json",
      },
    },
  );
  writeFixtureFile(
    root,
    `${packagePath}/index.cjs`,
    `module.exports = ${JSON.stringify(`${label}-require`)};\n`,
  );
  writeFixtureFile(
    root,
    `${packagePath}/feature.js`,
    `export default ${JSON.stringify(`${label}-feature-import`)};\n`,
  );
  writeFixtureFile(
    root,
    `${packagePath}/feature.cjs`,
    `module.exports = ${JSON.stringify(`${label}-feature-require`)};\n`,
  );
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

  writeFixtureFile(
    root,
    "package.json",
    JSON.stringify({ name: "vinext-externals-transitive", private: true, type: "module" }),
  );
  writeFixtureFile(
    root,
    "next.config.mjs",
    `export default { serverExternalPackages: ["shared-version", "nested-only", "require-only"] };\n`,
  );
  writeFixtureFile(
    root,
    "app/layout.tsx",
    `export default function Layout({ children }: { children: React.ReactNode }) {
  return <html><body>{children}</body></html>;
}\n`,
  );
  writeFixtureFile(
    root,
    "app/page.tsx",
    `import depA from "dep-a";
import depB from "dep-b";
import depC from "dep-c";
import rootVersion from "shared-version";
import rootFeature from "shared-version/feature";

export default function Page() {
  return <p id="versions">{depA}, {depB}, {depC}, root:{rootVersion}:{rootFeature}</p>;
}\n`,
  );

  writeConditionalPackage(root, "node_modules/shared-version", "1.0.0", "root");
  writePackage(
    root,
    "packages/dep-a",
    "1.0.0",
    `import version from "shared-version";
import feature from "shared-version/feature";
import nestedOnly from "nested-only";
export default "dep-a:" + version + ":" + feature + ":" + nestedOnly;\n`,
  );
  writeConditionalPackage(root, "packages/dep-a/node_modules/shared-version", "2.0.0", "nested-a");
  writePackage(
    root,
    "packages/dep-a/node_modules/nested-only",
    "1.0.0",
    `export default "nested-only";\n`,
  );
  writePackage(
    root,
    "packages/dep-b",
    "1.0.0",
    `import version from "shared-version";
import feature from "shared-version/feature";
import packageJson from "shared-version/package.json" with { type: "json" };
export default "dep-b:" + version + ":" + feature + ":" + packageJson.version;\n`,
  );
  writeConditionalPackage(root, "packages/dep-b/node_modules/shared-version", "3.0.0", "nested-b");
  writeFixtureFile(
    root,
    "packages/dep-c/package.json",
    JSON.stringify({ name: "dep-c", version: "1.0.0", main: "index.cjs" }),
  );
  writeFixtureFile(
    root,
    "packages/dep-c/index.cjs",
    `const version = require("shared-version");
const feature = require("shared-version/feature");
const requireOnly = require("require-only");
module.exports = "dep-c:" + version + ":" + feature + ":" + requireOnly;\n`,
  );
  writeConditionalPackage(root, "packages/dep-c/node_modules/shared-version", "4.0.0", "nested-c");
  writeFixtureFile(
    root,
    "packages/dep-c/node_modules/require-only/package.json",
    JSON.stringify({
      name: "require-only",
      version: "1.0.0",
      exports: { require: "./index.cjs" },
    }),
  );
  writeFixtureFile(
    root,
    "packages/dep-c/node_modules/require-only/index.cjs",
    `module.exports = "nested-require-only";\n`,
  );
  linkPackage(root, "dep-a");
  linkPackage(root, "dep-b");
  linkPackage(root, "dep-c");

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
  it("resolves external package versions relative to each importing dependency", async () => {
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
    if (!address || typeof address === "string") throw new Error("Production server did not bind");

    const response = await fetch(`http://127.0.0.1:${address.port}/`);
    const html = await response.text();
    const normalizedHtml = html.replaceAll("<!-- -->", "");
    expect(response.status, html).toBe(200);
    expect(normalizedHtml).toContain(
      "dep-a:nested-a-import:nested-a-feature-import:nested-only, " +
        "dep-b:nested-b-import:nested-b-feature-import:3.0.0, " +
        "dep-c:nested-c-require:nested-c-feature-require:nested-require-only, " +
        "root:root-import:root-feature-import",
    );
  }, 30_000);

  it("does not fall back to require-only exports for ESM imports from linked packages", async () => {
    const root = await mkdtemp(path.join(import.meta.dirname, ".tmp-externals-require-only-"));
    tempDirs.push(root);

    writeFixtureFile(
      root,
      "package.json",
      JSON.stringify({ name: "vinext-externals-require-only", private: true, type: "module" }),
    );
    writeFixtureFile(
      root,
      "next.config.mjs",
      `export default { serverExternalPackages: ["require-only"] };\n`,
    );
    writeFixtureFile(
      root,
      "app/layout.tsx",
      `export default function Layout({ children }: { children: React.ReactNode }) {
  return <html><body>{children}</body></html>;
}\n`,
    );
    writeFixtureFile(
      root,
      "app/page.tsx",
      `import dependency from "linked-dependency";
export default function Page() { return <p>{dependency}</p>; }\n`,
    );
    writePackage(
      root,
      "packages/linked-dependency",
      "1.0.0",
      `import value from "require-only";\nexport default value;\n`,
    );
    writeFixtureFile(
      root,
      "packages/linked-dependency/node_modules/require-only/package.json",
      JSON.stringify({
        name: "require-only",
        version: "1.0.0",
        exports: { require: "./index.cjs" },
      }),
    );
    writeFixtureFile(
      root,
      "packages/linked-dependency/node_modules/require-only/index.cjs",
      `module.exports = "must-not-load-for-import";\n`,
    );
    fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
    linkPackage(root, "linked-dependency");

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

    await expect(builder.buildApp()).rejects.toThrow(/require-only/);
  }, 30_000);
});
