import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createStyledJsxPlugin } from "../packages/vinext/src/plugins/styled-jsx.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function createPnpmStyleFixture(): { root: string; styledJsxRoot: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-styled-jsx-"));
  temporaryDirectories.push(root);
  const nextRoot = path.join(root, "node_modules", ".pnpm", "next@16", "node_modules", "next");
  const styledJsxRoot = path.join(
    root,
    "node_modules",
    ".pnpm",
    "styled-jsx@5",
    "node_modules",
    "styled-jsx",
  );
  fs.mkdirSync(path.join(nextRoot, "node_modules"), { recursive: true });
  fs.mkdirSync(styledJsxRoot, { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
  fs.writeFileSync(path.join(nextRoot, "package.json"), '{"name":"next"}');
  fs.writeFileSync(path.join(styledJsxRoot, "package.json"), '{"name":"styled-jsx"}');
  fs.writeFileSync(path.join(styledJsxRoot, "css.js"), "module.exports = {};");
  fs.symlinkSync(nextRoot, path.join(root, "node_modules", "next"), "dir");
  fs.symlinkSync(styledJsxRoot, path.join(nextRoot, "node_modules", "styled-jsx"), "dir");
  return { root, styledJsxRoot };
}

describe("styled-jsx compatibility plugin", () => {
  it("resolves styled-jsx subpaths from Next's dependency graph", () => {
    const { root, styledJsxRoot } = createPnpmStyleFixture();
    const plugin = createStyledJsxPlugin(root);
    const resolveId = plugin.resolveId as { handler(source: string): string | null };

    expect(fs.realpathSync(resolveId.handler("styled-jsx/css")!)).toBe(
      fs.realpathSync(path.join(styledJsxRoot, "css.js")),
    );
  });

  it("uses Next's matching compiler for styled-jsx source", async () => {
    const loadBindings = vi.fn(async () => undefined);
    const transform = vi.fn(async () => ({
      code: 'import _JSXStyle from "styled-jsx/style"; export default _JSXStyle;',
      map: '{"version":3}',
    }));
    const importModule = vi.fn(async () => ({ loadBindings, transform }));
    const plugin = createStyledJsxPlugin(process.cwd(), { importModule });
    const transformHook = plugin.transform as {
      handler(source: string, id: string): Promise<{ code: string; map: string | null }>;
    };

    const result = await transformHook.handler(
      'import css from "styled-jsx/css"; const styles = css`button { color: hotpink; }`;',
      "/app/component.js",
    );

    expect(loadBindings).toHaveBeenCalledOnce();
    expect(transform).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        filename: "/app/component.js",
        styledJsx: { useLightningcss: false },
        jsc: expect.objectContaining({ parser: { syntax: "ecmascript", jsx: true } }),
      }),
    );
    expect(result.code).toContain("styled-jsx/style");
  });

  it("parses JSX in JavaScript module extensions", async () => {
    const transform = vi.fn(async () => ({ code: "export default null;" }));
    const plugin = createStyledJsxPlugin(process.cwd(), {
      importModule: async () => ({ loadBindings: async () => undefined, transform }),
    });
    const transformHook = plugin.transform as {
      handler(source: string, id: string): Promise<unknown>;
    };

    await transformHook.handler("export default <style jsx>{`p{color:red}`}</style>", "/app/a.mjs");

    expect(transform).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        jsc: expect.objectContaining({ parser: { syntax: "ecmascript", jsx: true } }),
      }),
    );
  });
});
