import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import React from "react";
import { renderToReadableStream } from "react-dom/server.edge";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createStyledJsxPlugin } from "../packages/vinext/src/plugins/styled-jsx.js";
import type { StyledJsxRuntime } from "../packages/vinext/src/shims/styled-jsx-registry.js";

const temporaryDirectories: string[] = [];

const SSR_REGISTRY_IMPORT = 'import "virtual:vinext-styled-jsx-ssr-registry";';

type ResolveIdHook = {
  handler(
    this: unknown,
    source: string,
    importer?: string,
    options?: { scan?: boolean },
  ): string | null;
};

type StyledJsxModule = StyledJsxRuntime & {
  style: React.ComponentType<{ id: string; children?: string }>;
};

// The same styled-jsx copy vinext resolves for apps: the one Next depends on.
const requireFromNext = createRequire(createRequire(import.meta.url).resolve("next/package.json"));
const styledJsx = requireFromNext("styled-jsx") as StyledJsxModule;

async function renderToString(element: React.ReactElement): Promise<string> {
  const stream = await renderToReadableStream(element);
  await stream.allReady;
  return new Response(stream).text();
}

function createFakeCompilerPlugin(code: string) {
  return createStyledJsxPlugin(process.cwd(), {
    importModule: async () => ({
      loadBindings: async () => undefined,
      transform: async () => ({ code }),
    }),
  });
}

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
        disableNextSsg: true,
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

  it("keeps getServerSideProps in compiled pages", async () => {
    // Next's compiler strips data-fetching exports unless `disableNextSsg` is
    // set; losing them silently rendered styled-jsx pages without props.
    const plugin = createStyledJsxPlugin(process.cwd());
    const transformHook = plugin.transform as {
      handler(source: string, id: string): Promise<{ code: string }>;
    };

    const result = await transformHook.handler(
      "export default function Page({ color }) { return <style jsx>{`p{color:${color}}`}</style>; }\n" +
        'export function getServerSideProps() { return { props: { color: "green" } }; }',
      "/app/pages/index.js",
    );

    expect(result.code).toContain("export function getServerSideProps()");
  });

  it("registers the Pages SSR runtime from compiled server modules", async () => {
    const compiled = 'import _JSXStyle from "styled-jsx/style";\nexport default _JSXStyle;';
    const plugin = createFakeCompilerPlugin(compiled);
    const transformHook = plugin.transform as {
      handler(this: unknown, source: string, id: string): Promise<{ code: string }>;
    };
    const transformIn = (environment: unknown) =>
      transformHook.handler.call(
        { environment },
        "export default <style jsx>{`p{color:red}`}</style>",
        "/app/pages/index.jsx",
      );

    const ssr = await transformIn({ name: "ssr", config: { consumer: "server" } });
    // Appended after the compiler output so its source map stays aligned.
    expect(ssr.code.startsWith(compiled)).toBe(true);
    expect(ssr.code).toContain(SSR_REGISTRY_IMPORT);
    const client = await transformIn({ name: "client", config: { consumer: "client" } });
    expect(client.code).not.toContain(SSR_REGISTRY_IMPORT);
    const rsc = await transformIn({ name: "rsc", config: { consumer: "server" } });
    expect(rsc.code).not.toContain(SSR_REGISTRY_IMPORT);

    const cssOnly = createFakeCompilerPlugin("export const className = 'jsx-123';");
    const cssOnlyResult = await (cssOnly.transform as typeof transformHook).handler.call(
      { environment: { name: "ssr", config: { consumer: "server" } } },
      'import css from "styled-jsx/css"; export const styles = css.resolve`p{color:red}`;',
      "/app/styles.js",
    );
    expect(cssOnlyResult.code).not.toContain(SSR_REGISTRY_IMPORT);
  });

  it("serves the SSR registry module that hands styled-jsx to vinext", () => {
    const plugin = createStyledJsxPlugin(process.cwd());
    const resolveId = plugin.resolveId as ResolveIdHook;
    const load = plugin.load as { handler(id: string): string };

    const resolved = resolveId.handler("virtual:vinext-styled-jsx-ssr-registry");
    expect(resolved).toBe("\0virtual:vinext-styled-jsx-ssr-registry");
    const code = load.handler(resolved!);
    expect(code).toContain('from "styled-jsx"');
    expect(code).toContain('from "vinext/shims/styled-jsx-registry"');
    expect(code).toContain("registerStyledJsxRuntime(");
  });

  it("routes styled-jsx through a discovering dev dependency optimizer", () => {
    const plugin = createStyledJsxPlugin(process.cwd());
    const resolveId = plugin.resolveId as ResolveIdHook;
    const rawStyle = resolveId.handler("styled-jsx/style");
    expect(rawStyle).toBe(requireFromNext.resolve("styled-jsx/style"));

    const registerMissingImport = vi.fn((id: string, src: string) => ({ id, src }));
    const createEnvironment = (options: { noDiscovery: boolean; exclude?: string[] }) => ({
      mode: "dev",
      name: "client",
      config: { consumer: "client", resolve: { external: [] } },
      depsOptimizer: {
        options,
        registerMissingImport,
        getOptimizedDepId: (info: { id: string }) =>
          `/node_modules/.vite/deps/${info.id.replaceAll("/", "_")}.js?v=test`,
      },
    });

    expect(
      resolveId.handler.call(
        { environment: createEnvironment({ noDiscovery: false }) },
        "styled-jsx/style",
        "/app/pages/index.jsx",
        {},
      ),
    ).toBe("/node_modules/.vite/deps/styled-jsx_style.js?v=test");
    expect(registerMissingImport).toHaveBeenCalledWith("styled-jsx/style", rawStyle);

    registerMissingImport.mockClear();
    const discovering = createEnvironment({ noDiscovery: false });
    expect(
      resolveId.handler.call({ environment: discovering }, "styled-jsx/style", undefined, {
        scan: true,
      }),
    ).toBe(rawStyle);
    expect(
      resolveId.handler.call(
        { environment: createEnvironment({ noDiscovery: true }) },
        "styled-jsx/style",
      ),
    ).toBe(rawStyle);
    expect(
      resolveId.handler.call(
        { environment: createEnvironment({ noDiscovery: false, exclude: ["styled-jsx"] }) },
        "styled-jsx/style",
      ),
    ).toBe(rawStyle);
    expect(registerMissingImport).not.toHaveBeenCalled();
  });

  it("exposes natively required styled-jsx through an ESM facade", () => {
    const plugin = createStyledJsxPlugin(process.cwd());
    const resolveId = plugin.resolveId as ResolveIdHook;
    const load = plugin.load as { handler(id: string): string };
    const file = resolveId.handler("styled-jsx")!;

    const code = load.handler(`\0vinext-styled-jsx-node:${file}`);

    const fileLiteral = JSON.stringify(file);
    expect(code).toContain(`createRequire(${fileLiteral})(${fileLiteral})`);
    expect(code).toContain("export default mod;");
    expect(code).toContain("export const StyleRegistry = mod.StyleRegistry;");
    expect(code).toContain("export const createStyleRegistry = mod.createStyleRegistry;");
  });
});

// Next.js wraps every Pages render in styled-jsx's StyleRegistry and hands the
// collected styles to `_document`: packages/next/src/server/render.tsx
// (search `jsxStyleRegistry`).
describe("styled-jsx Pages SSR registry", () => {
  async function loadRegisteredRuntime() {
    vi.resetModules();
    const registry = await import("../packages/vinext/src/shims/styled-jsx-registry.js");
    const documentProps =
      await import("../packages/vinext/src/server/pages-document-initial-props.js");
    const pagesStyledJsx = await import("../packages/vinext/src/server/pages-styled-jsx.js");
    return { registry, documentProps, pagesStyledJsx };
  }

  function styledElement(css: string, id = "abc") {
    return React.createElement(
      "div",
      null,
      React.createElement(styledJsx.style, { id }, css),
      React.createElement("p", { className: `jsx-${id}` }, "styled"),
    );
  }

  it("only wraps renders once a styled-jsx module registered the runtime", async () => {
    const { registry } = await loadRegisteredRuntime();
    expect(registry.createPagesStyledJsxCollector()).toBeNull();

    registry.registerStyledJsxRuntime(styledJsx);
    expect(registry.createPagesStyledJsxCollector()).not.toBeNull();
  });

  it("collects styles rendered inside the collector and flushes them once", async () => {
    const { registry, pagesStyledJsx } = await loadRegisteredRuntime();
    registry.registerStyledJsxRuntime(styledJsx);
    const collector = registry.createPagesStyledJsxCollector()!;

    const body = await renderToString(collector.wrap(styledElement("p.jsx-abc{color:red}")));

    // JSXStyle renders nothing inline; the rule is collected for the head.
    expect(body).toBe('<div><p class="jsx-abc">styled</p></div>');
    expect(
      await pagesStyledJsx.renderStyledJsxStylesHTML(collector, "test-nonce", renderToString),
    ).toBe('<style id="__jsx-abc" nonce="test-nonce">p.jsx-abc{color:red}</style>');
    expect(
      await pagesStyledJsx.renderStyledJsxStylesHTML(collector, undefined, renderToString),
    ).toBe("");
  });

  it("emits shell rules immediately before the React root", async () => {
    const { pagesStyledJsx } = await loadRegisteredRuntime();
    const styles = '<style id="__jsx-abc">p.jsx-abc{color:red}</style>';
    const prefix = '<!DOCTYPE html><html><head></head><body class="custom"><div id="__next">';

    expect(pagesStyledJsx.insertStyledJsxBeforePagesRoot(prefix, styles)).toBe(
      `<!DOCTYPE html><html><head></head><body class="custom">${styles}<div id="__next">`,
    );
    expect(
      pagesStyledJsx.insertStyledJsxBeforePagesRoot(
        '<html><head></head><body><div id="__next"><p>x</p></div></body></html>',
        styles,
      ),
    ).toBe(`<html><head></head><body>${styles}<div id="__next"><p>x</p></div></body></html>`);
    expect(pagesStyledJsx.insertStyledJsxBeforePagesRoot(prefix, "")).toBe(prefix);
  });

  it("appends rules registered after the shell outside the React root, once", async () => {
    const { registry, pagesStyledJsx } = await loadRegisteredRuntime();
    registry.registerStyledJsxRuntime(styledJsx);
    const collector = registry.createPagesStyledJsxCollector()!;
    await renderToString(collector.wrap(styledElement("p.jsx-abc{color:red}")));
    const headHTML = await pagesStyledJsx.renderStyledJsxStylesHTML(
      collector,
      undefined,
      renderToString,
    );
    expect(headHTML).toBe('<style id="__jsx-abc">p.jsx-abc{color:red}</style>');

    // Later (Suspense) content registers a new rule plus one the shell emitted.
    await renderToString(
      collector.wrap(
        React.createElement(
          React.Fragment,
          null,
          styledElement("p.jsx-abc{color:red}"),
          styledElement("p.jsx-late{color:blue}", "late"),
        ),
      ),
    );
    const suffix = '</div>\n  <script id="__NEXT_DATA__"></script>\n</body>\n</html>';

    expect(
      await pagesStyledJsx.appendLateStyledJsxStyles(suffix, collector, undefined, renderToString),
    ).toBe(
      '</div><style id="__jsx-late">p.jsx-late{color:blue}</style>' +
        '\n  <script id="__NEXT_DATA__"></script>\n</body>\n</html>',
    );
    expect(
      await pagesStyledJsx.appendLateStyledJsxStyles(suffix, collector, undefined, renderToString),
    ).toBe(suffix);
    expect(
      await pagesStyledJsx.appendLateStyledJsxStyles(suffix, null, undefined, renderToString),
    ).toBe(suffix);
  });

  it("returns collected styles from ctx.defaultGetInitialProps()", async () => {
    const { registry, documentProps } = await loadRegisteredRuntime();
    registry.registerStyledJsxRuntime(styledJsx);
    function StyledDocument() {
      return null;
    }
    let initialStyles: unknown;
    StyledDocument.getInitialProps = async (ctx: {
      defaultGetInitialProps(ctx: unknown): Promise<{ html: string; styles?: unknown }>;
    }) => {
      const initialProps = await ctx.defaultGetInitialProps(ctx);
      initialStyles = initialProps.styles;
      return initialProps;
    };

    const result = await documentProps.runDocumentRenderPage({
      DocumentComponent: StyledDocument,
      enhancePageElement: () => styledElement("p.jsx-abc{color:red}"),
      renderToReadableStream,
      renderStylesToString: renderToString,
      styledJsx: registry.createPagesStyledJsxCollector(),
    });

    expect(Array.isArray(initialStyles) && initialStyles.length).toBe(1);
    expect(result.status).toBe("rendered");
    if (result.status !== "rendered") return;
    expect(result.bodyHtml).toContain('class="jsx-abc"');
    // Flushed by defaultGetInitialProps, so the rule is emitted exactly once.
    expect(result.stylesHTML).toBe('<style id="__jsx-abc">p.jsx-abc{color:red}</style>');
  });

  it("keeps styles registered by a custom renderPage-only getInitialProps", async () => {
    const { registry, documentProps } = await loadRegisteredRuntime();
    registry.registerStyledJsxRuntime(styledJsx);
    function RenderPageDocument() {
      return null;
    }
    RenderPageDocument.getInitialProps = async (ctx: {
      renderPage(): Promise<{ html: string }>;
    }) => {
      const page = await ctx.renderPage();
      return { html: page.html, styles: React.createElement("style", { id: "document-style" }) };
    };

    const result = await documentProps.runDocumentRenderPage({
      DocumentComponent: RenderPageDocument,
      enhancePageElement: () => styledElement("p.jsx-abc{color:red}"),
      renderToReadableStream,
      renderStylesToString: renderToString,
      styledJsx: registry.createPagesStyledJsxCollector(),
    });

    expect(result.status).toBe("rendered");
    if (result.status !== "rendered") return;
    // Next.js still emits the unflushed registry (`styledJsxInsertedHTML`).
    expect(result.stylesHTML).toBe(
      '<style id="document-style"></style><style id="__jsx-abc">p.jsx-abc{color:red}</style>',
    );
  });
});
