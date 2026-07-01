import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createBuilder } from "vite";
import { afterEach, expect, it } from "vitest";
import vinext from "../packages/vinext/src/index.js";
import {
  collectMatchingWebpackLoaderRules,
  createWebpackLoaderCompatPlugin,
} from "../packages/vinext/src/plugins/webpack-loader-compat.js";

const roots: string[] = [];

function readJavaScript(dir: string): string {
  let source = "";
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) source += readJavaScript(entryPath);
    else if (/\.m?js$/.test(entry.name)) source += fs.readFileSync(entryPath, "utf8");
  }
  return source;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

it("requires parent webpack rule conditions before matching nested loaders", () => {
  const nestedRule = { use: ["nested-loader"] };
  const rules = [{ test: /\.svg$/, rules: [nestedRule] }];

  expect(collectMatchingWebpackLoaderRules(rules, "/app/icon.svg")).toContain(nestedRule);
  expect(collectMatchingWebpackLoaderRules(rules, "/app/page.tsx")).not.toContain(nestedRule);
});

it("matches resource query and issuer conditions", () => {
  const queryRule = { test: /\.svg$/, resourceQuery: /react/, use: ["query-loader"] };
  const issuerRule = { test: /\.svg$/, issuer: /page\.tsx$/, use: ["issuer-loader"] };
  const rules = [queryRule, issuerRule];

  expect(
    collectMatchingWebpackLoaderRules(rules, "/app/icon.svg", "?react", "/app/page.tsx"),
  ).toEqual(expect.arrayContaining([queryRule, issuerRule]));
  expect(
    collectMatchingWebpackLoaderRules(rules, "/app/icon.svg", "?url", "/app/layout.tsx"),
  ).toEqual([]);
});

it("leaves Next.js framework loader rules to Vite", async () => {
  const plugin = createWebpackLoaderCompatPlugin(
    () => ({
      client: [{ test: /\.tsx$/, use: ["next-babel-loader"] }],
      server: [{ test: /\.tsx$/, use: ["next-babel-loader"] }],
    }),
    () => "/app",
  );
  const resolveId = plugin.resolveId;
  expect(resolveId).toBeTypeOf("function");
  if (typeof resolveId !== "function") return;

  const result = await resolveId.call(
    {
      environment: { name: "rsc" },
      resolve: async () => ({ id: "/app/page.tsx" }),
    } as never,
    "./page.tsx",
    "/app/layout.tsx",
    {} as never,
  );
  expect(result).toBeNull();
});

it("keeps custom loaders from mixed framework loader chains", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-webpack-loader-mixed-"));
  roots.push(root);
  const loaderPath = path.join(root, "custom-loader.cjs");
  fs.writeFileSync(loaderPath, `module.exports = () => 'export default "custom-output"'`);
  fs.writeFileSync(path.join(root, "value.txt"), "source");

  const plugin = createWebpackLoaderCompatPlugin(
    () => ({
      client: [],
      server: [{ test: /\.txt$/, use: ["next-babel-loader", loaderPath] }],
    }),
    () => root,
  );
  const resolveId = plugin.resolveId;
  const load = plugin.load;
  expect(resolveId).toBeTypeOf("function");
  expect(load).toBeTypeOf("function");
  if (typeof resolveId !== "function" || typeof load !== "function") return;

  const context = {
    environment: { name: "rsc", mode: "build" },
    resolve: async () => ({ id: path.join(root, "value.txt") }),
  } as never;
  const resolved = await resolveId.call(
    context,
    "./value.txt",
    path.join(root, "page.tsx"),
    {} as never,
  );
  expect(resolved).toBeTypeOf("string");
  const output = await load.call(context, resolved as string, {} as never);
  expect(output).toBe('export default "custom-output"');
});

it("runs custom loaders whose paths contain mdx", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-webpack-loader-custom-mdx-"));
  roots.push(root);
  const loaderPath = path.join(root, "mdx-frontmatter-loader.cjs");
  fs.writeFileSync(loaderPath, `module.exports = () => 'export default "custom-mdx-output"'`);
  fs.writeFileSync(path.join(root, "value.txt"), "source");

  const plugin = createWebpackLoaderCompatPlugin(
    () => ({ client: [], server: [{ test: /\.txt$/, use: [loaderPath] }] }),
    () => root,
  );
  const context = {
    environment: { name: "rsc", mode: "build" },
    resolve: async () => ({ id: path.join(root, "value.txt") }),
  } as never;
  const resolved = await (plugin.resolveId as Function).call(
    context,
    "./value.txt",
    path.join(root, "page.tsx"),
    {},
  );
  const output = await (plugin.load as Function).call(context, resolved, {});
  expect(output).toBe('export default "custom-mdx-output"');
});

it("preserves resource queries for matching loaders", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-webpack-loader-query-"));
  roots.push(root);
  const loaderPath = path.join(root, "query-loader.cjs");
  fs.writeFileSync(
    loaderPath,
    `module.exports = function () { return 'export default ' + JSON.stringify(this.resourceQuery) }`,
  );
  fs.writeFileSync(path.join(root, "icon.svg"), "source");

  const plugin = createWebpackLoaderCompatPlugin(
    () => ({
      client: [],
      server: [{ test: /\.svg$/, resourceQuery: /react/, use: [loaderPath] }],
    }),
    () => root,
  );
  const context = {
    environment: { name: "rsc", mode: "build" },
    resolve: async () => ({ id: `${path.join(root, "icon.svg")}?react` }),
  } as never;
  const resolved = await (plugin.resolveId as Function).call(
    context,
    "./icon.svg?react",
    path.join(root, "page.tsx"),
    {},
  );
  const output = await (plugin.load as Function).call(context, resolved, {});
  expect(output).toBe('export default "?react"');
});

it("waits for async loader callbacks instead of using sync returns", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-webpack-loader-async-"));
  roots.push(root);
  const loaderPath = path.join(root, "async-loader.cjs");
  fs.writeFileSync(
    loaderPath,
    `module.exports = function () { const done = this.async(); setTimeout(() => done(null, 'export default "async-output"'), 0); return 'export default "sync-output"' }`,
  );
  fs.writeFileSync(path.join(root, "value.txt"), "source");

  const plugin = createWebpackLoaderCompatPlugin(
    () => ({ client: [], server: [{ test: /\.txt$/, use: [loaderPath] }] }),
    () => root,
  );
  const resolveId = plugin.resolveId;
  const load = plugin.load;
  expect(resolveId).toBeTypeOf("function");
  expect(load).toBeTypeOf("function");
  if (typeof resolveId !== "function" || typeof load !== "function") return;

  const context = {
    environment: { name: "rsc", mode: "build" },
    resolve: async () => ({ id: path.join(root, "value.txt") }),
  } as never;
  const resolved = await resolveId.call(
    context,
    "./value.txt",
    path.join(root, "page.tsx"),
    {} as never,
  );
  const output = await load.call(context, resolved as string, {} as never);
  expect(output).toBe('export default "async-output"');
});

it("applies matching webpack loaders to App Router modules", async () => {
  // Ported from Next.js: test/e2e/app-dir/webpack-loader-set-environment-variable/
  // webpack-loader-set-environment-variable.test.ts
  // https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/webpack-loader-set-environment-variable/webpack-loader-set-environment-variable.test.ts
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-webpack-loader-"));
  roots.push(root);
  const previousEnv = process.env.TEST_THIS_THING;
  delete process.env.TEST_THIS_THING;
  fs.symlinkSync(
    path.resolve(import.meta.dirname, "../node_modules"),
    path.join(root, "node_modules"),
  );
  fs.mkdirSync(path.join(root, "app"));
  fs.writeFileSync(
    path.join(root, "custom-loader.cjs"),
    `module.exports = () => { process.env.TEST_THIS_THING = "def"; return 'export default () => "The svg rendered"' }`,
  );
  fs.writeFileSync(
    path.join(root, "next.config.cjs"),
    `const { join } = require("node:path"); module.exports = { webpack(config) { config.module.rules.push({ test: /\\.svg$/, use: [join(__dirname, "custom-loader.cjs")] }); return config } }`,
  );
  fs.writeFileSync(
    path.join(root, "app", "layout.tsx"),
    `export default function Layout({ children }) { return <html><body>{children}</body></html> }`,
  );
  fs.writeFileSync(
    path.join(root, "app", "page.tsx"),
    `import Svg from "./next.svg"; export default function Page() { return <div id="the-svg"><Svg /></div> }`,
  );
  fs.writeFileSync(
    path.join(root, "app", "next.svg"),
    `<svg xmlns="http://www.w3.org/2000/svg" />`,
  );

  try {
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

    expect(readJavaScript(path.join(root, "dist/server"))).toContain("The svg rendered");
    expect(process.env.TEST_THIS_THING).toBe("def");
  } finally {
    if (previousEnv === undefined) delete process.env.TEST_THIS_THING;
    else process.env.TEST_THIS_THING = previousEnv;
  }
});

it("keeps client and server webpack loader rules environment-specific", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-webpack-loader-env-"));
  roots.push(root);
  fs.symlinkSync(
    path.resolve(import.meta.dirname, "../node_modules"),
    path.join(root, "node_modules"),
  );
  fs.mkdirSync(path.join(root, "app"));
  fs.writeFileSync(
    path.join(root, "client-loader.cjs"),
    `module.exports = () => 'export default "client-loader-output"'`,
  );
  fs.writeFileSync(
    path.join(root, "server-loader.cjs"),
    `module.exports = () => 'export default "server-loader-output"'`,
  );
  fs.writeFileSync(
    path.join(root, "next.config.cjs"),
    `const { join } = require("node:path"); module.exports = { webpack(config, { isServer }) { config.module.rules.push({ test: /\\.txt$/, use: [join(__dirname, isServer ? "server-loader.cjs" : "client-loader.cjs")] }); return config } }`,
  );
  fs.writeFileSync(
    path.join(root, "app", "layout.tsx"),
    `export default function Layout({ children }) { return <html><body>{children}</body></html> }`,
  );
  fs.writeFileSync(
    path.join(root, "app", "client.tsx"),
    `"use client"; import value from "./value.txt"; export default function Client() { return <div>{value}</div> }`,
  );
  fs.writeFileSync(
    path.join(root, "app", "page.tsx"),
    `import Client from "./client"; import value from "./value.txt"; export default function Page() { return <><div>{value}</div><Client /></> }`,
  );
  fs.writeFileSync(path.join(root, "app", "value.txt"), "source");

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

  const serverSource = readJavaScript(path.join(root, "dist/server"));
  const clientSource = readJavaScript(path.join(root, "dist/client"));
  expect(serverSource).toContain("server-loader-output");
  expect(serverSource).not.toContain("client-loader-output");
  expect(clientSource).toContain("client-loader-output");
  expect(clientSource).not.toContain("server-loader-output");
});
