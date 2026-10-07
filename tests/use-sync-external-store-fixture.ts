import fs from "node:fs/promises";
import { findPackageJSON } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const externalStoreImports = [
  "use-sync-external-store/shim",
  "use-sync-external-store/shim/index.js",
  "use-sync-external-store/shim/with-selector",
  "use-sync-external-store/shim/with-selector.js",
  "use-sync-external-store/with-selector",
  "use-sync-external-store/with-selector.js",
];

export async function createExternalStoreFixture(
  layout: "hoisted" | "nested" | "absent" = "hoisted",
): Promise<string> {
  const repo = process.cwd();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-external-store-"));
  const write = async (file: string, contents: string) => {
    const target = path.join(root, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, contents);
  };
  try {
    await fs.mkdir(path.join(root, "node_modules"));
    for (const name of ["react", "react-dom", "vite", "vinext", "@vitejs"]) {
      const source = path.join(
        repo,
        name === "vinext" ? "packages/vinext" : `node_modules/${name}`,
      );
      await fs.symlink(source, path.join(root, "node_modules", name), "junction");
    }
    const rscPlugin = await fs.realpath(
      path.join(repo, "node_modules/@vitejs/plugin-rsc/package.json"),
    );
    await fs.symlink(
      path.dirname(findPackageJSON("react-server-dom-webpack", pathToFileURL(rscPlugin))!),
      path.join(root, "node_modules/react-server-dom-webpack"),
      "junction",
    );
    await write("package.json", JSON.stringify({ name: "external-store-fixture", type: "module" }));
    await write("warnings.json", "[]");
    await write(
      "vite.config.ts",
      `import { createLogger, defineConfig } from "vite";
import { writeFileSync } from "node:fs";
import vinext from "vinext";
const warnings = [];
const logger = createLogger("warn");
logger.warn = (message) => {
  warnings.push(message);
  writeFileSync(${JSON.stringify(path.join(root, "warnings.json"))}, JSON.stringify(warnings));
};
logger.warnOnce = logger.warn;
export default defineConfig({
  customLogger: logger,
  cacheDir: ".vite",
  plugins: [vinext()],
  optimizeDeps: {
    // Keep the parent on one raw ESM path for RSC client references. Its
    // CommonJS children still need prebundling even with this exclusion.
    exclude: ["nested-client-store-lib"],
    // Isolated transitive installs use Vite's supported parent-qualified includes.
    include: ${JSON.stringify(layout === "nested" ? externalStoreImports.map((id) => `nested-client-store-lib > ${id}`) : [])},
  },
});`,
    );
    await write(
      "app/layout.tsx",
      `import Counter from "./counter";
export default function Layout({children}) {
  return <html><body><Counter />{children}</body></html>;
}`,
    );
    await write(
      "app/counter.tsx",
      `"use client";
import {useState} from "react";
export default function Counter() {
  const [count, setCount] = useState(0);
  return <button id="counter" onClick={() => setCount(count + 1)}>counter:{count}</button>;
}`,
    );
    if (layout === "absent") {
      await write("app/page.tsx", "export default () => <h1>No external store dependency</h1>;");
      return root;
    }

    // Reuse the real, locked CommonJS package already installed for the SWR example.
    const swr = await fs.realpath(
      findPackageJSON(
        "swr",
        pathToFileURL(path.join(repo, "examples/realworld-api-rest/package.json")),
      )!,
    );
    const store = path.dirname(findPackageJSON("use-sync-external-store", pathToFileURL(swr))!);
    const packageDir = "node_modules/nested-client-store-lib";
    await fs.cp(
      store,
      path.join(
        root,
        layout === "nested" ? packageDir : "",
        "node_modules/use-sync-external-store",
      ),
      { recursive: true },
    );
    await write(
      `${packageDir}/package.json`,
      JSON.stringify({ name: "nested-client-store-lib", type: "module", exports: "./index.js" }),
    );
    await write(
      `${packageDir}/index.js`,
      externalStoreImports
        .map((_, index) => `export {Store${index}} from "./internal/store-${index}.js";`)
        .join("\n"),
    );
    for (const [index, id] of externalStoreImports.entries()) {
      const hook = id.includes("with-selector")
        ? "useSyncExternalStoreWithSelector"
        : "useSyncExternalStore";
      await write(
        `${packageDir}/internal/store-${index}.js`,
        `"use client";
import {createElement, useState} from "react";
import {${hook}} from ${JSON.stringify(id)};
const subscribe = () => () => {};
export function Store${index}() {
  const [count, setCount] = useState(0);
  const value = ${hook}(subscribe, () => "client", () => "server", value => value);
  return createElement("button", {id: "store-${index}", onClick: () => setCount(count + 1)}, value + ":" + count);
}`,
      );
    }
    for (const [route, indices, href] of [
      ["", [0, 1], "/selectors"],
      ["selectors/", [2, 3, 4, 5], "/"],
    ] as const) {
      await write(
        `app/${route}page.tsx`,
        `import Link from "next/link";
import {${indices.map((index) => `Store${index}`).join(",")}} from "nested-client-store-lib";
export default function Page() {
  return <>${indices.map((index) => `<Store${index} />`).join("")}<Link id="next-page" prefetch={false} href="${href}">Next page</Link></>;
}`,
      );
    }
    return root;
  } catch (error) {
    await fs.rm(root, { recursive: true, force: true });
    throw error;
  }
}
