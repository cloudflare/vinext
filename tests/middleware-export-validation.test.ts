import { describe, expect, it } from "vitest";
import {
  hasValidMiddlewareModuleExport,
  validateMiddlewareModuleExports,
} from "../packages/vinext/src/plugins/middleware-export-validation.js";

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
