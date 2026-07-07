import fs from "node:fs";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";

const ROOT_NODE_MODULES = path.resolve(process.cwd(), "node_modules");

const ESM_EXTERNALS_PAGE_TEXT = "Hello World+World+World+World+World+World+World+World+World+World";
const ESM_EXTERNALS_APP_SERVER_TEXT = "Hello World+World+World+World";
const ESM_EXTERNALS_APP_CLIENT_TEXT = "Hello World+World+World";
export const ESM_EXTERNALS_ROUTE_EXPECTATIONS = [
  { kind: "pages", route: "/static", text: ESM_EXTERNALS_PAGE_TEXT },
  { kind: "pages", route: "/ssr", text: ESM_EXTERNALS_PAGE_TEXT },
  { kind: "pages", route: "/ssg", text: ESM_EXTERNALS_PAGE_TEXT },
  { kind: "app", route: "/server", text: ESM_EXTERNALS_APP_SERVER_TEXT },
  { kind: "app", route: "/client", text: ESM_EXTERNALS_APP_CLIENT_TEXT },
] as const;

export const ESM_EXTERNALS_APP_TRANSITIVE_PACKAGE = "app-transitive-esm-package";
export const ESM_EXTERNALS_IMPLICIT_PAGE_PACKAGES = ["esm-package1", "esm-package2"] as const;
export const ESM_EXTERNALS_EXPLICIT_APP_PACKAGES = [
  "app-esm-package1",
  "app-esm-package2",
  "app-cjs-esm-package",
] as const;
export const ESM_EXTERNALS_BUNDLED_PAGE_PACKAGES = [
  "extensionless-esm-package",
  "transpiled-esm-package",
] as const;

const BROWSER_WORLD_SOURCE = `export default 'World'\n\nif (!process.browser) throw new Error('Browser only code in server build')\n`;
const ESM_WORLD_SOURCE = `export default 'World'\n\nif (Math.random() < 0) import('fail')\n`;
const ESM_TLA_WORLD_SOURCE = `export default 'World'\n\nawait 1\n\nif (Math.random() < 0) import('fail')\n`;
const CJS_WORLD_SOURCE = `module.exports = 'World'\n\nif (Math.random() < 0) require('fail')\n`;
const WRONG_CJS_SOURCE = `module.exports = 'Wrong'\n`;
const TRANSPILED_WORLD_SOURCE = `const loadedFromNodeModules = import.meta.url.includes("/node_modules/transpiled-esm-package/");\nexport default loadedFromNodeModules ? 'Externalized' : 'World';\n\nif (Math.random() < 0) import(/* @vite-ignore */ 'fail')\n`;
// Rolldown resolves dead dynamic imports when bundling. Keep the same sentinel
// shape, but ignore resolution here so the route can prove bundled-vs-external.
const APP_TRANSITIVE_WORLD_SOURCE = `const loadedFromNodeModules = import.meta.url.includes("/node_modules/${ESM_EXTERNALS_APP_TRANSITIVE_PACKAGE}/");\nexport default loadedFromNodeModules ? 'Externalized' : 'World';\n\nif (Math.random() < 0) import(/* @vite-ignore */ 'fail')\n`;

type ConditionalExportPackageOptions = {
  directory: string;
  packageName?: string;
  packageType?: "module";
  browserFile: string;
  importFile: string;
  requireFile: string;
  importSource: string;
  requireSource: string;
};

export type EsmExternalsFixture = {
  root: string;
  cleanup: () => void;
};

export async function closeServer(server: Server): Promise<void> {
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeIdleConnections();
  server.closeAllConnections();
  await closed;
}

function normalizeHtmlText(value: string): string {
  return value.replace(/<!-- -->/g, "");
}

export function firstParagraphText(html: string): string {
  const match = /<p[^>]*>(.*?)<\/p>/s.exec(html);
  if (!match) throw new Error(`Expected HTML to contain a paragraph: ${html}`);
  return normalizeHtmlText(match[1]!.replace(/<[^>]*>/g, ""));
}

function linkWorkspacePackage(tmpDir: string, specifier: string): void {
  const directSource = path.join(ROOT_NODE_MODULES, specifier);
  const source = fs.existsSync(directSource)
    ? fs.realpathSync(directSource)
    : findPnpmPackageSource(specifier);
  const destination = path.join(tmpDir, "node_modules", specifier);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.symlinkSync(source, destination, "junction");
}

function findPnpmPackageSource(specifier: string): string {
  const packageDirName = specifier.replace("/", "+");
  const pnpmDir = path.join(ROOT_NODE_MODULES, ".pnpm");
  const entry = fs
    .readdirSync(pnpmDir)
    .find(
      (candidate) => candidate === packageDirName || candidate.startsWith(`${packageDirName}@`),
    );
  if (!entry) {
    throw new Error(`Unable to locate ${specifier} in ${ROOT_NODE_MODULES}`);
  }

  return fs.realpathSync(path.join(pnpmDir, entry, "node_modules", specifier));
}

function writeFile(root: string, relativePath: string, source: string): void {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, source);
}

function writePackage(
  root: string,
  name: string,
  packageJson: object,
  files: Record<string, string>,
): void {
  writeFile(root, `node_modules/${name}/package.json`, JSON.stringify(packageJson, null, 2));
  for (const [fileName, source] of Object.entries(files)) {
    writeFile(root, `node_modules/${name}/${fileName}`, source);
  }
}

function writeConditionalExportPackage(
  root: string,
  {
    directory,
    packageName = directory,
    packageType,
    browserFile,
    importFile,
    requireFile,
    importSource,
    requireSource,
  }: ConditionalExportPackageOptions,
): void {
  writePackage(
    root,
    directory,
    {
      name: packageName,
      ...(packageType ? { type: packageType } : {}),
      exports: {
        "./package.json": "./package.json",
        "./entry": {
          browser: `./${browserFile}`,
          import: `./${importFile}`,
          require: `./${requireFile}`,
        },
      },
    },
    {
      [browserFile]: BROWSER_WORLD_SOURCE,
      [importFile]: importSource,
      [requireFile]: requireSource,
    },
  );
}

export async function createEsmExternalsFixture(): Promise<EsmExternalsFixture> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-esm-externals-"));

  fs.mkdirSync(path.join(tmpDir, "node_modules"), { recursive: true });
  for (const specifier of [
    "react",
    "react-dom",
    "react-server-dom-webpack",
    "vite",
    "@vitejs/plugin-react",
    "@vitejs/plugin-rsc",
    "@mdx-js/react",
    "@mdx-js/rollup",
    "ipaddr.js",
  ]) {
    linkWorkspacePackage(tmpDir, specifier);
  }

  writeFile(tmpDir, "package.json", JSON.stringify({ type: "module" }));
  writeFile(
    tmpDir,
    "next.config.mjs",
    `export default {
  output: "standalone",
  turbopack: {
    resolveAlias: {
      "preact/compat": "react",
    },
  },
  transpilePackages: ["transpiled-esm-package"],
  serverExternalPackages: ["app-esm-package1", "app-esm-package2", "app-cjs-esm-package"],
  webpack(config) {
    config.resolve.alias = {
      ...config.resolve.alias,
      "preact/compat": "react",
    };
    return config;
  },
};
`,
  );

  writeConditionalExportPackage(tmpDir, {
    directory: "esm-package1",
    packageName: "esm-package",
    browserFile: "browser.mjs",
    importFile: "correct.mjs",
    requireFile: "wrong.js",
    importSource: ESM_WORLD_SOURCE,
    requireSource: WRONG_CJS_SOURCE,
  });
  writeConditionalExportPackage(tmpDir, {
    directory: "esm-package2",
    packageName: "esm-package",
    packageType: "module",
    browserFile: "browser.mjs",
    importFile: "correct.js",
    requireFile: "wrong.cjs",
    importSource: ESM_TLA_WORLD_SOURCE,
    requireSource: WRONG_CJS_SOURCE,
  });
  writeConditionalExportPackage(tmpDir, {
    directory: "invalid-esm-package",
    browserFile: "browser.js",
    importFile: "correct.js",
    requireFile: "alternative.js",
    importSource: `export default 'World'\n`,
    requireSource: `module.exports = 'Alternative'\n\nif (Math.random() < 0) require('fail')\n`,
  });
  writeConditionalExportPackage(tmpDir, {
    directory: "app-esm-package1",
    packageName: "app-esm-package",
    browserFile: "browser.mjs",
    importFile: "correct.mjs",
    requireFile: "wrong.js",
    importSource: ESM_WORLD_SOURCE,
    requireSource: WRONG_CJS_SOURCE,
  });
  writeConditionalExportPackage(tmpDir, {
    directory: "app-esm-package2",
    packageName: "app-esm-package",
    packageType: "module",
    browserFile: "browser.mjs",
    importFile: "correct.js",
    requireFile: "wrong.cjs",
    importSource: ESM_TLA_WORLD_SOURCE,
    requireSource: WRONG_CJS_SOURCE,
  });
  writeConditionalExportPackage(tmpDir, {
    directory: "app-cjs-esm-package",
    browserFile: "browser.js",
    importFile: "correct.js",
    requireFile: "alternative.js",
    importSource: CJS_WORLD_SOURCE,
    requireSource: `module.exports = 'Alternative'\n`,
  });
  writeConditionalExportPackage(tmpDir, {
    directory: "extensionless-esm-package",
    packageType: "module",
    browserFile: "browser.mjs",
    importFile: "correct.js",
    requireFile: "wrong.cjs",
    importSource: `import World from './dep';\n\nexport default World;\n\nif (Math.random() < 0) import('fail')\n`,
    requireSource: WRONG_CJS_SOURCE,
  });
  writeFile(tmpDir, "node_modules/extensionless-esm-package/dep.js", `export default 'World'\n`);
  writeConditionalExportPackage(tmpDir, {
    directory: "transpiled-esm-package",
    packageType: "module",
    browserFile: "browser.mjs",
    importFile: "correct.js",
    requireFile: "wrong.cjs",
    importSource: TRANSPILED_WORLD_SOURCE,
    requireSource: WRONG_CJS_SOURCE,
  });
  writeConditionalExportPackage(tmpDir, {
    directory: ESM_EXTERNALS_APP_TRANSITIVE_PACKAGE,
    packageType: "module",
    browserFile: "browser.mjs",
    importFile: "correct.js",
    requireFile: "wrong.cjs",
    importSource: APP_TRANSITIVE_WORLD_SOURCE,
    requireSource: WRONG_CJS_SOURCE,
  });
  writePackage(
    tmpDir,
    "app-wrapper-package",
    { name: "app-wrapper-package", type: "module", exports: { ".": "./index.js" } },
    {
      "index.js": `import World from "${ESM_EXTERNALS_APP_TRANSITIVE_PACKAGE}/entry";\n\nexport default World;\n`,
    },
  );
  writePackage(
    tmpDir,
    "fail",
    { name: "fail", type: "module", exports: "./index.js" },
    { "index.js": `throw new Error('Dead dynamic import should not execute')\n` },
  );
  writePackage(
    tmpDir,
    "preact",
    { name: "preact", exports: { "./compat": "./compat.js" } },
    { "compat.js": `throw new Error('Should not be executed')\n` },
  );

  const pagesSource = `import React from "preact/compat";
import World1 from "esm-package1/entry";
import World2 from "esm-package2/entry";
import World3 from "invalid-esm-package/entry";
import World4 from "extensionless-esm-package/entry";
import World5 from "transpiled-esm-package/entry";

const worlds = "World+World+World+World+World";

export default function Index({ worlds: propWorlds = worlds }) {
  return <p>Hello {World1}+{World2}+{World3}+{World4}+{World5}+{propWorlds}</p>;
}
`;
  writeFile(tmpDir, "pages/static.js", pagesSource);
  writeFile(
    tmpDir,
    "pages/ssr.js",
    pagesSource.replace(
      'const worlds = "World+World+World+World+World";',
      `export function getServerSideProps() {
  return { props: { worlds: \`\${World1}+\${World2}+\${World3}+\${World4}+\${World5}\` } };
}`,
    ),
  );
  writeFile(
    tmpDir,
    "pages/ssg.js",
    pagesSource.replace(
      'const worlds = "World+World+World+World+World";',
      `export async function getStaticProps() {
  return { props: { worlds: \`\${World1}+\${World2}+\${World3}+\${World4}+\${World5}\` } };
}`,
    ),
  );

  writeFile(
    tmpDir,
    "app/layout.js",
    `export default function Layout({ children }) {
  return <html><body>{children}</body></html>;
}
`,
  );
  writeFile(
    tmpDir,
    "app/server/page.js",
    `import World1 from "app-esm-package1/entry";
import World2 from "app-esm-package2/entry";
import World3 from "app-cjs-esm-package/entry";
import WrappedWorld from "app-wrapper-package";

export default function Page() {
  return <p>Hello {World1}+{World2}+{World3}+{WrappedWorld}</p>;
}
`,
  );
  writeFile(
    tmpDir,
    "app/client/page.js",
    `"use client";

import World1 from "app-esm-package1/entry";
import World2 from "app-esm-package2/entry";
import World3 from "app-cjs-esm-package/entry";

export default function Page() {
  return <p>Hello {World1}+{World2}+{World3}</p>;
}
`,
  );

  return {
    root: tmpDir,
    cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
  };
}
