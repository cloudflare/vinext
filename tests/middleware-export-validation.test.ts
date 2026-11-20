import { describe, expect, it } from "vite-plus/test";
import {
  hasValidMiddlewareModuleExport,
  validateMiddlewareModuleExports,
} from "../packages/vinext/src/plugins/middleware-export-validation.js";
import { validateAppClientEntryExports } from "../packages/vinext/src/plugins/app-client-entry-exports.js";

describe("middleware/proxy static export validation", () => {
  it.each([
    ["default function", "export default function handler() {}"],
    ["default arrow", "export default () => {}"],
    ["named function", "export function proxy() {}"],
    ["named variable", "export const proxy = () => {}"],
    ["named specifier", "const proxy = () => {}; export { proxy }"],
    ["aliased to proxy", "const handler = () => {}; export { handler as proxy }"],
    ["re-exported proxy", 'export { proxy } from "./handler"'],
    ["non-function named value", "export const proxy = 1"],
    ["non-function default value", "export default {}"],
    ["type-only export", "type proxy = () => void; export type { proxy }"],
  ])("accepts proxy %s", (_name, source) => {
    expect(hasValidMiddlewareModuleExport(source, "/app/proxy.ts", true)).toBe(true);
  });

  it.each([
    ["wrong named function", "export function middleware() {}"],
    ["wrong alias", "const proxy = () => {}; export { proxy as handler }"],
    ["no exports", "const proxy = () => {}"],
  ])("rejects proxy %s", (_name, source) => {
    expect(hasValidMiddlewareModuleExport(source, "/app/proxy.ts", true)).toBe(false);
  });

  it("uses the middleware named export for middleware files", () => {
    expect(
      hasValidMiddlewareModuleExport(
        "export function middleware() {}",
        "/app/middleware.ts",
        false,
      ),
    ).toBe(true);
    expect(
      hasValidMiddlewareModuleExport("export function proxy() {}", "/app/middleware.ts", false),
    ).toBe(false);
  });

  it("throws the canonical Next.js diagnostic", () => {
    expect(() =>
      validateMiddlewareModuleExports(
        "export function middleware() {}",
        "/app/proxy.ts",
        "/app/proxy.ts",
        true,
      ),
    ).toThrow(
      'The file "./proxy.ts" must export a function, either as a default export or as a named "proxy" export.',
    );
  });

  it("analyzes original CommonJS source before interop transforms", () => {
    expect(hasValidMiddlewareModuleExport("module.exports = () => {}", "/app/proxy.js", true)).toBe(
      false,
    );
  });
});

// Messages and matching rules probed against next@16.2.7: rejected where both
// `next build --webpack` and `next build --turbopack` fail.
describe('App Router "use client" entry export validation', () => {
  const metadataMessage = (name: string) =>
    `You are attempting to export "${name}" from a component marked with "use client", which is disallowed. "${name}" must be resolved on the server before the page component is rendered. Keep your page as a Server Component and move Client Component logic to a separate file. Read more: https://nextjs.org/docs/app/api-reference/functions/generate-metadata#why-generatemetadata-is-server-component-only`;
  const generateStaticParamsMessage =
    'Next.js can\'t recognize the exported `generateStaticParams` field in route. App pages cannot use both "use client" and export function "generateStaticParams()".';
  const unstableInstantMessage =
    'Next.js can\'t recognize the exported `unstable_instant` field in route. App pages cannot export "unstable_instant" from a Client Component module. To use this API, convert this module to a Server Component by removing the "use client" directive.';
  const validate = (exports: string, id = "/app/page.tsx") =>
    validateAppClientEntryExports(`"use client";\n${exports}`, id);

  it("rejects metadata exports from a client page with Next.js's messages", () => {
    const source = `'use client'
export async function generateMetadata() { return { title: "x" }; }
export const metadata = { title: "y" };
export function generateViewport() { return {}; }
export const viewport = { themeColor: "red" };
export default function Page() { return <p>cm</p>; }
`;
    expect(() => validateAppClientEntryExports(source, "/app/cm/page.js")).toThrow(
      `${metadataMessage("generateMetadata")}\n\n${metadataMessage("metadata")}`,
    );
  });

  it.each([
    ["a declared function", "export function generateStaticParams() { return []; }"],
    ["an async function", "export async function generateStaticParams() { return []; }"],
    ["a declared TypeScript function", "export declare function generateStaticParams(): [];"],
    ["a variable", "export let generateStaticParams = () => [];"],
    [
      "its local name",
      "function generateStaticParams() { return []; }\nexport { generateStaticParams as gsp };",
    ],
    ["a re-export", 'export { generateStaticParams } from "./gsp";'],
    [
      "a type-only export",
      "type generateStaticParams = () => [];\nexport type { generateStaticParams };",
    ],
    [
      "a function before a later specifier",
      "export function generateStaticParams() { return []; }\nconst x = 1;\nexport { x as getStaticProps };",
    ],
    [
      "a specifier after another static info function",
      "function generateStaticParams() { return []; }\nexport function generateSitemaps() { return []; }\nexport { generateStaticParams as gsp };",
    ],
  ])("rejects generateStaticParams exported as %s", (_name, exports) => {
    expect(() => validate(exports)).toThrow(generateStaticParamsMessage);
  });

  it.each([
    ["a static value", 'export const unstable_instant = { prefetch: "static" };'],
    ["false", "export const unstable_instant = false;"],
    ["undefined", "export const unstable_instant = undefined;"],
    ["a value Next.js can't read", "const i = {};\nexport const unstable_instant = i;"],
    ["a later declarator", 'export const a = 1, unstable_instant = { prefetch: "static" };'],
  ])("rejects unstable_instant exported as %s", (_name, exports) => {
    expect(() => validate(exports)).toThrow(unstableInstantMessage);
  });

  it("checks layout and route files", () => {
    for (const id of ["/app/layout.js", "/app/api/route.ts"]) {
      expect(() => validate("export const metadata = {};", id)).toThrow(
        metadataMessage("metadata"),
      );
      expect(() => validate("export function generateStaticParams() { return []; }", id)).toThrow(
        generateStaticParamsMessage,
      );
      expect(() => validate('export const unstable_instant = { prefetch: "static" };', id)).toThrow(
        unstableInstantMessage,
      );
    }
  });

  it.each([
    ["a local name", "const metadata = {};\nexport { metadata as pageMetadata };", "metadata"],
    ["a re-export", 'export { generateMetadata } from "./meta";', "generateMetadata"],
    ["a later declarator", "export const a = 1, metadata = {};", "metadata"],
  ])("rejects metadata exported under %s", (_name, exports, rejected) => {
    expect(() => validate(exports, "/app/layout.js")).toThrow(metadataMessage(rejected));
  });

  // Webpack builds accept each of these, so a Next.js app may ship them.
  it.each([
    [
      "viewport, segment config and other generator exports",
      `export function generateViewport() { return {}; }
export const viewport = { themeColor: "red" };
export const revalidate = 60;
export const dynamic = "force-static";
export function generateImageMetadata() { return []; }
export function generateSitemaps() { return []; }`,
    ],
    ["metadata exported under a local alias", "const foo = {};\nexport { foo as metadata };"],
    ["metadata from a class", "export class metadata {}"],
    ["destructured metadata", "export const { metadata } = { metadata: {} };"],
    ["a type-only metadata export", "type metadata = {};\nexport type { metadata };"],
    [
      "a type-only metadata specifier",
      "type generateMetadata = {};\nexport { type generateMetadata };",
    ],
    ["a declared metadata variable", "export declare const metadata: {};"],
    [
      "imported metadata types",
      'import type { Metadata as metadata } from "next";\nexport { metadata };',
    ],
    [
      "an imported metadata type",
      'import { type Metadata as metadata } from "next";\nexport { metadata };',
    ],
    [
      "generateStaticParams exported from another name",
      "function gsp() { return []; }\nexport { gsp as generateStaticParams };",
    ],
    ["generateStaticParams from a class", "export class generateStaticParams {}"],
    [
      "generateStaticParams as a later declarator",
      "export const x = 1, generateStaticParams = () => [];",
    ],
    ["a destructured generateStaticParams", "export const [generateStaticParams] = [() => []];"],
    [
      "generateStaticParams followed by another static info function",
      "export function generateStaticParams() { return []; }\nexport const generateSitemaps = () => [];",
    ],
    ["a namespace re-export", 'export * as generateStaticParams from "./gsp";'],
    ["unstable_instant from a function", "export function unstable_instant() {}"],
    ["unstable_instant from a let", 'export let unstable_instant = { prefetch: "static" };'],
    [
      "unstable_instant from another name",
      'const i = { prefetch: "static" };\nexport { i as unstable_instant };',
    ],
    [
      "unstable_instant in a file Next.js reads no static info from",
      'export  const unstable_instant = { prefetch: "static" };',
    ],
  ])("allows %s", (_name, exports) => {
    expect(() => validate(exports)).not.toThrow();
  });

  it("reads static info from the file as written", () => {
    const code = '"use client";\nexport const unstable_instant = { prefetch: "static" };';
    expect(() =>
      validateAppClientEntryExports(
        code,
        "/app/page.js",
        '"use client";\nexport  const unstable_instant = { prefetch: "static" };',
      ),
    ).not.toThrow();
    expect(() => validateAppClientEntryExports(code, "/app/page.js")).toThrow(
      unstableInstantMessage,
    );
  });

  it("runs only the requested checks", () => {
    const metadata = '"use client";\nexport const metadata = {};';
    const generateStaticParams = '"use client";\nexport function generateStaticParams() {}';
    const staticInfoOnly = { metadata: false, staticInfo: true };
    const metadataOnly = { metadata: true, staticInfo: false };
    expect(() =>
      validateAppClientEntryExports(metadata, "/shared/c.js", metadata, staticInfoOnly),
    ).not.toThrow();
    expect(() =>
      validateAppClientEntryExports(metadata, "/shared/page.js", metadata, metadataOnly),
    ).toThrow('You are attempting to export "metadata"');
    expect(() =>
      validateAppClientEntryExports(
        generateStaticParams,
        "/shared/page.js",
        generateStaticParams,
        metadataOnly,
      ),
    ).not.toThrow();
    expect(() =>
      validateAppClientEntryExports(
        generateStaticParams,
        "/shared/c.js",
        generateStaticParams,
        staticInfoOnly,
      ),
    ).toThrow("generateStaticParams");
  });

  it.each([
    [
      "a server page",
      "export const metadata = {}; export function generateStaticParams() { return []; }",
    ],
    [
      'a "use client" string after the directive prologue',
      'import "./x"; "use client"; export const metadata = {};',
    ],
  ])("allows exports from %s", (_name, source) => {
    expect(() => validateAppClientEntryExports(source, "/app/page.js")).not.toThrow();
  });
});
