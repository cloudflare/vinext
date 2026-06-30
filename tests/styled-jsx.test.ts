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
  it("detects supported styled-jsx syntax variants", async () => {
    const plugin = createStyledJsxPlugin(process.cwd());
    const transformHook = plugin.transform as {
      handler(source: string, id: string): Promise<{ code: string } | null>;
    };

    const nestedExpression = await transformHook.handler(
      "export default <style nonce={/* user's nonce */ getNonce({ fallback: true })} global jsx>{`body{color:red}`}</style>",
      "/app/nested.jsx",
    );
    const cssImport = await transformHook.handler(
      'const css = require ("styled-jsx/css"); export const styles = css`p{color:red}`;',
      "/app/css.js",
    );
    const ordinaryStyle = await transformHook.handler(
      'export default <style data-language="jsx">{styles}</style>',
      "/app/ordinary.jsx",
    );
    const hyphenatedAttribute = await transformHook.handler(
      "export default <style jsx-global>{styles}</style>",
      "/app/hyphenated.jsx",
    );

    expect(nestedExpression?.code).toContain('from "styled-jsx/style"');
    expect(cssImport).not.toBeNull();
    expect(ordinaryStyle).toBeNull();
    expect(hyphenatedAttribute).toBeNull();
  });

  it("resolves styled-jsx subpaths from Next's dependency graph", () => {
    const { root, styledJsxRoot } = createPnpmStyleFixture();
    const plugin = createStyledJsxPlugin(root);
    const resolveId = plugin.resolveId as { handler(source: string): string | null };

    expect(fs.realpathSync(resolveId.handler("styled-jsx/css")!)).toBe(
      fs.realpathSync(path.join(styledJsxRoot, "css.js")),
    );
  });

  it("leaves ordinary style tags untouched when Next is not installed", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-no-next-"));
    temporaryDirectories.push(root);
    fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
    const importModule = vi.fn();
    const plugin = createStyledJsxPlugin(root, { importModule });
    const transformHook = plugin.transform as {
      handler(source: string, id: string): Promise<unknown>;
    };

    await expect(
      transformHook.handler(
        'export default <style data-language="jsx">{styles}</style>',
        "/app/ordinary.jsx",
      ),
    ).resolves.toBeNull();
    expect(importModule).not.toHaveBeenCalled();
  });

  it("rejects styled-jsx tags when Next is not installed", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-no-next-"));
    temporaryDirectories.push(root);
    fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
    const plugin = createStyledJsxPlugin(root);
    const transformHook = plugin.transform as {
      handler(source: string, id: string): Promise<unknown>;
    };

    await expect(
      transformHook.handler(
        "export default <style nonce={/* user's nonce */ getNonce({ fallback: true })} jsx>{`p{color:red}`}</style>",
        "/app/styled.jsx",
      ),
    ).rejects.toThrow("styled-jsx requires an installed next package");
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

  it("skips styled-jsx transforms for dependency files", async () => {
    const importModule = vi.fn();
    const plugin = createStyledJsxPlugin(process.cwd(), { importModule });
    const transformHook = plugin.transform as {
      filter: { id: { exclude: RegExp } };
      handler(source: string, id: string): Promise<unknown>;
    };

    const result = await transformHook.handler(
      'import css from "styled-jsx/css"; export const styles = css`p{color:red}`;',
      "/app/node_modules/dependency/component.js",
    );

    expect(transformHook.filter.id.exclude.test("/app/node_modules/dependency/component.js")).toBe(
      true,
    );
    expect(result).toBeNull();
    expect(importModule).not.toHaveBeenCalled();
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

  it("uses development JSX without browser refresh globals in dev", async () => {
    let receivedOptions: Record<string, unknown> | undefined;
    const transform = vi.fn(async (_source: string, options: Record<string, unknown>) => {
      receivedOptions = options;
      return { code: "export default null;" };
    });
    const plugin = createStyledJsxPlugin(process.cwd(), {
      importModule: async () => ({ loadBindings: async () => undefined, transform }),
    });
    const configResolved = plugin.configResolved as (config: {
      root: string;
      command: "serve";
    }) => void;
    configResolved({ root: process.cwd(), command: "serve" });
    const transformHook = plugin.transform as {
      handler(source: string, id: string): Promise<unknown>;
    };

    await transformHook.handler("export default <style jsx>{`p{color:red}`}</style>", "/app/a.js");

    expect(transform).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        jsc: expect.objectContaining({
          transform: expect.objectContaining({
            react: expect.objectContaining({ development: true }),
          }),
        }),
      }),
    );
    const reactOptions = (
      receivedOptions as { jsc: { transform: { react: Record<string, unknown> } } }
    ).jsc.transform.react;
    expect(reactOptions).not.toHaveProperty("refresh");
  });

  it("transforms styled-jsx with the installed Next compiler", async () => {
    const plugin = createStyledJsxPlugin(process.cwd());
    const transformHook = plugin.transform as {
      handler(source: string, id: string): Promise<{ code: string }>;
    };

    const result = await transformHook.handler(
      'import css from "styled-jsx/css"; const styles = css`button { color: hotpink; }`; export default function Page() { return <style jsx>{styles}</style>; }',
      "/app/page.js",
    );

    expect(result.code).toContain('from "styled-jsx/style"');
    expect(result.code).toContain("button.jsx-");
    expect(result.code).not.toContain("styled-jsx/css");
  });

  it("transforms global style tags", async () => {
    const plugin = createStyledJsxPlugin(process.cwd());
    const transformHook = plugin.transform as {
      handler(source: string, id: string): Promise<{ code: string }>;
    };

    const globalStyle = await transformHook.handler(
      "export default <style global jsx>{`body{color:hotpink}`}</style>",
      "/app/global.js",
    );

    expect(globalStyle.code).toContain('from "styled-jsx/style"');
  });

  it("keeps real dev transforms safe for server environments", async () => {
    const plugin = createStyledJsxPlugin(process.cwd());
    const configResolved = plugin.configResolved as (config: {
      root: string;
      command: "serve";
    }) => void;
    configResolved({ root: process.cwd(), command: "serve" });
    const transformHook = plugin.transform as {
      handler(source: string, id: string): Promise<{ code: string }>;
    };

    const result = await transformHook.handler(
      "export default function Page() { return <style jsx>{`p{color:red}`}</style>; }",
      "/app/page.js",
    );

    expect(result.code).toContain("jsxDEV");
    expect(result.code).not.toContain("$RefreshReg$");
    expect(result.code).not.toContain("$RefreshSig$");
  });
});
