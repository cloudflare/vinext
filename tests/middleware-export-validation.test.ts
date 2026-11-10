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

// Messages and matching rules probed against next@16.2.7 (webpack and Turbopack).
describe('App Router "use client" entry export validation', () => {
  const metadataMessage = (name: string) =>
    `You are attempting to export "${name}" from a component marked with "use client", which is disallowed. "${name}" must be resolved on the server before the page component is rendered. Keep your page as a Server Component and move Client Component logic to a separate file. Read more: https://nextjs.org/docs/app/api-reference/functions/generate-metadata#why-generatemetadata-is-server-component-only`;
  const generateStaticParamsMessage =
    'Next.js can\'t recognize the exported `generateStaticParams` field in route. App pages cannot use both "use client" and export function "generateStaticParams()".';

  it("rejects metadata exports from a client page with Next.js's messages", () => {
    const source = `'use client'
export async function generateMetadata() { return { title: "x" }; }
export const metadata = { title: "y" };
export function generateViewport() { return {}; }
export const viewport = { themeColor: "red" };
export default function Page() { return <p>cm</p>; }
`;
    expect(() => validateAppClientEntryExports(source, "/app/cm/page.js", "entry")).toThrow(
      `${metadataMessage("generateMetadata")}\n\n${metadataMessage("metadata")}`,
    );
  });

  it("rejects generateStaticParams from a client page or default file", () => {
    const source = `"use client";
export function generateStaticParams() { return []; }
export default function Page() { return null; }
`;
    expect(() => validateAppClientEntryExports(source, "/app/cp/page.tsx", "entry")).toThrow(
      generateStaticParamsMessage,
    );
    expect(() =>
      validateAppClientEntryExports(source, "/app/@slot/default.tsx", "default"),
    ).toThrow(generateStaticParamsMessage);
  });

  it("checks metadata only in page, layout and route files", () => {
    const source = `"use client";
export const metadata = { title: "y" };
export default function Default() { return null; }
`;
    expect(() =>
      validateAppClientEntryExports(source, "/app/@slot/default.js", "default"),
    ).not.toThrow();
  });

  it.each([
    [
      "metadata from a local name",
      "const metadata = {}; export { metadata as pageMetadata };",
      "metadata",
    ],
    [
      "metadata re-exported from another module",
      'export { generateMetadata } from "./meta";',
      "generateMetadata",
    ],
  ])("rejects %s", (_name, exports, rejected) => {
    expect(() =>
      validateAppClientEntryExports(`"use client";\n${exports}`, "/app/layout.js", "entry"),
    ).toThrow(metadataMessage(rejected));
  });

  it.each([
    [
      "an aliased function",
      "function gsp() { return []; } export { gsp as generateStaticParams };",
    ],
    ["a class", "export class generateStaticParams {}"],
  ])("rejects generateStaticParams exported as %s", (_name, exports) => {
    expect(() =>
      validateAppClientEntryExports(`"use client";\n${exports}`, "/app/page.js", "entry"),
    ).toThrow(generateStaticParamsMessage);
  });

  it.each([
    [
      "viewport, segment config and other generator exports",
      `"use client";
export function generateViewport() { return {}; }
export const viewport = { themeColor: "red" };
export const revalidate = 60;
export const dynamic = "force-static";
export function generateImageMetadata() { return []; }
export function generateSitemaps() { return []; }`,
    ],
    [
      "a server page",
      "export const metadata = {}; export function generateStaticParams() { return []; }",
    ],
    [
      'a "use client" string after the directive prologue',
      'import "./x"; "use client"; export const metadata = {};',
    ],
    [
      "metadata exported under a local alias",
      '"use client"; const foo = {}; export { foo as metadata };',
    ],
    [
      "generateStaticParams exported under another name",
      '"use client"; function generateStaticParams() { return []; } export { generateStaticParams as gsp };',
    ],
  ])("allows %s", (_name, source) => {
    expect(() => validateAppClientEntryExports(source, "/app/page.js", "entry")).not.toThrow();
  });

  it("ignores type-only exports", () => {
    const source = `"use client";
type metadata = { title: string };
export type { metadata };
export declare const generateMetadata: () => void;
export default function Page() { return null; }
`;
    expect(() => validateAppClientEntryExports(source, "/app/page.tsx", "entry")).not.toThrow();
  });
});
