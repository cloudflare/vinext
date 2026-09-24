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

type LoadHook = {
  handler(this: unknown, id: string): Promise<string>;
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

function writeSource(root: string, file: string, source: string): void {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), source);
}

/** A project with Next's styled-jsx installed and the given source files. */
function createProject(sources: Record<string, string>): string {
  const { root, styledJsxRoot } = createPnpmStyleFixture();
  fs.writeFileSync(path.join(styledJsxRoot, "index.js"), "module.exports = {};");
  for (const [file, source] of Object.entries(sources)) writeSource(root, file, source);
  return root;
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

  // Dev compiles modules on demand, so a styled-jsx module that is only loaded
  // lazily has not been seen before the first render. Dev servers ask whether
  // the project uses styled-jsx to load the registration up front.
  it("detects styled-jsx usage in project sources for dev", async () => {
    const usesStyledJsx = (root: string) => createStyledJsxPlugin(root).api!.projectUsesStyledJsx();
    const plainSources = {
      "pages/index.jsx": 'export default () => <style data-language="jsx">{css}</style>;',
      // Dependencies, dot directories and build output are not the project's.
      "node_modules/lib/index.jsx": "export default () => <style jsx>{css}</style>;",
      ".cache/stale.jsx": "export default () => <style jsx>{css}</style>;",
      "dist/server/entry.js": 'import css from "styled-jsx/css";',
    };

    expect(await usesStyledJsx(createProject(plainSources))).toBe(false);
    expect(
      await usesStyledJsx(
        createProject({
          ...plainSources,
          "components/Lazy.jsx": "export default () => <style global jsx>{css}</style>;",
        }),
      ),
    ).toBe(true);
    expect(
      await usesStyledJsx(
        createProject({
          "lib/styles.ts": 'import css from "styled-jsx/css";\nexport default css``;',
        }),
      ),
    ).toBe(true);

    // A module compiled with styled-jsx during the session counts too.
    const compiledRoot = createProject(plainSources);
    writeSource(compiledRoot, "node_modules/next/dist/build/swc/index.js", "module.exports = {};");
    const compiled = createStyledJsxPlugin(compiledRoot, {
      importModule: async () => ({
        loadBindings: async () => undefined,
        transform: async () => ({ code: 'import _JSXStyle from "styled-jsx/style";' }),
      }),
    });
    expect(await compiled.api!.projectUsesStyledJsx()).toBe(false);
    await (compiled.transform as { handler(source: string, id: string): Promise<unknown> }).handler(
      "export default <style jsx>{`p{color:red}`}</style>",
      "/app/added.jsx",
    );
    expect(await compiled.api!.projectUsesStyledJsx()).toBe(true);

    // Without a resolvable styled-jsx the registration could not load.
    const noNext = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-no-next-"));
    temporaryDirectories.push(noNext);
    writeSource(noNext, "pages/index.jsx", "export default () => <style jsx>{css}</style>;");
    expect(await usesStyledJsx(noNext)).toBe(false);
  });

  // A dependency that ships styled-jsx precompiled is never compiled here and
  // is not the project's source; if it is only loaded lazily, nothing else
  // tells dev to register styled-jsx before the first render.
  it("detects dependencies that ship styled-jsx from the project's manifests", async () => {
    const createApp = (
      dependencies: Record<string, string>,
      installed: Record<string, object> = {},
    ) => {
      const root = createProject({ "pages/index.jsx": "export default () => <p>plain</p>;" });
      writeSource(root, "package.json", JSON.stringify({ name: "app", dependencies }));
      // Next itself always depends on styled-jsx.
      writeSource(
        root,
        "node_modules/.pnpm/next@16/node_modules/next/package.json",
        JSON.stringify({ name: "next", dependencies: { "styled-jsx": "5.1.6" } }),
      );
      for (const [name, manifest] of Object.entries(installed)) {
        writeSource(
          root,
          `node_modules/${name}/package.json`,
          JSON.stringify({ name, ...manifest }),
        );
      }
      return root;
    };
    const usesStyledJsx = (root: string) => createStyledJsxPlugin(root).api!.projectUsesStyledJsx();

    expect(await usesStyledJsx(createApp({ next: "16" }))).toBe(false);
    expect(
      await usesStyledJsx(
        createApp(
          { next: "16", "ui-kit": "1", "dev-only": "1" },
          {
            "ui-kit": { dependencies: { react: "19" } },
            // Only the package's own development needs it.
            "dev-only": { devDependencies: { "styled-jsx": "5" } },
          },
        ),
      ),
    ).toBe(false);
    for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
      expect(
        await usesStyledJsx(
          createApp(
            { next: "16", "ui-kit": "1" },
            { "ui-kit": { [field]: { "styled-jsx": "5" } } },
          ),
        ),
      ).toBe(true);
    }
    // The app installing styled-jsx itself.
    expect(await usesStyledJsx(createApp({ next: "16", "styled-jsx": "5" }))).toBe(true);

    // Without a resolvable styled-jsx the registration could not load.
    const noNext = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-no-next-"));
    temporaryDirectories.push(noNext);
    writeSource(noNext, "package.json", JSON.stringify({ dependencies: { "ui-kit": "1" } }));
    writeSource(
      noNext,
      "node_modules/ui-kit/package.json",
      JSON.stringify({ name: "ui-kit", peerDependencies: { "styled-jsx": "5" } }),
    );
    expect(await usesStyledJsx(noNext)).toBe(false);
  });

  // The scan runs once. styled-jsx added later in the session to a module
  // that is only loaded lazily is not compiled before the render that needs
  // it, so added/changed source files must still turn the answer positive —
  // and generated dev entries, which import the dev registration module once,
  // must reload it.
  /** The styled-jsx plugin in a dev server whose `ssr` environment loaded the dev registration. */
  function startDevPlugin(root: string) {
    const plugin = createStyledJsxPlugin(root);
    (plugin.configResolved as (config: object) => void)({ command: "serve", root });
    const invalidateModule = vi.fn();
    const send = vi.fn();
    const devModule = { id: "\0virtual:vinext-styled-jsx-dev-registration" };
    (plugin.configureServer as (server: object) => void)({
      environments: {
        ssr: {
          moduleGraph: {
            getModuleById: (id: string) => (id === devModule.id ? devModule : undefined),
            invalidateModule,
          },
          hot: { send },
        },
      },
    });
    const watchChange = (file: string, event = "create") =>
      (plugin.watchChange as (id: string, change: { event: string }) => void)(file, { event });
    const loadDevModule = () => (plugin.load as LoadHook).handler(devModule.id);
    return { plugin, devModule, invalidateModule, send, watchChange, loadDevModule };
  }

  it("notices styled-jsx added after a negative dev scan", async () => {
    const root = createProject({
      "pages/index.jsx": "export default () => <p>plain</p>;",
    });
    const { plugin, devModule, invalidateModule, send, watchChange, loadDevModule } =
      startDevPlugin(root);
    const resolved = (plugin.resolveId as ResolveIdHook).handler(
      "virtual:vinext-styled-jsx-dev-registration",
    );

    expect(resolved).toBe(devModule.id);
    expect(await plugin.api!.projectUsesStyledJsx()).toBe(false);
    expect(await loadDevModule()).toBe("export {};\n");

    // Files the scan skips, and changes without styled-jsx, change nothing.
    writeSource(root, "node_modules/lib/index.jsx", "export default () => <style jsx>{c}</style>;");
    watchChange(path.join(root, "node_modules/lib/index.jsx"));
    writeSource(root, "pages/other.jsx", "export default () => <p>other</p>;");
    watchChange(path.join(root, "pages/other.jsx"));
    expect(await plugin.api!.projectUsesStyledJsx()).toBe(false);
    expect(invalidateModule).not.toHaveBeenCalled();

    // A lazily loaded component with styled-jsx is added.
    writeSource(root, "components/Lazy.jsx", "export default () => <style jsx>{css}</style>;");
    watchChange(path.join(root, "components/Lazy.jsx"));

    expect(await plugin.api!.projectUsesStyledJsx()).toBe(true);
    expect(invalidateModule).toHaveBeenCalledWith(devModule);
    expect(send).toHaveBeenCalledWith({ type: "full-reload" });
    expect(await loadDevModule()).toBe('import "virtual:vinext-styled-jsx-ssr-registry";\n');
    // Reloaded once: later changes leave the (now populated) module alone.
    watchChange(path.join(root, "components/Lazy.jsx"), "update");
    expect(invalidateModule).toHaveBeenCalledTimes(1);
  });

  // Workspace packages linked into the app's dependencies are compiled as
  // source (unlike installed dependencies), possibly only once loaded lazily.
  it("scans and watches linked workspace packages for styled-jsx", async () => {
    const createLinkedProject = (linkedSource: string) => {
      const root = createProject({ "pages/index.jsx": "export default () => <p>plain</p>;" });
      const linked = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-linked-"));
      temporaryDirectories.push(linked);
      writeSource(linked, "package.json", '{"name":"linked"}');
      writeSource(linked, "src/Styled.jsx", linkedSource);
      // Dependencies of the linked package are not its source.
      writeSource(
        linked,
        "node_modules/dep/index.jsx",
        "export default () => <style jsx>{c}</style>;",
      );
      fs.symlinkSync(linked, path.join(root, "node_modules", "linked"), "dir");
      return { root, linked };
    };

    const styled = createLinkedProject("export default () => <style jsx>{`p{color:red}`}</style>;");
    expect(await createStyledJsxPlugin(styled.root).api!.projectUsesStyledJsx()).toBe(true);

    const { root, linked } = createLinkedProject("export default () => <p>linked</p>;");
    const { plugin, watchChange } = startDevPlugin(root);
    expect(await plugin.api!.projectUsesStyledJsx()).toBe(false);

    watchChange(path.join(linked, "node_modules/dep/index.jsx"));
    expect(await plugin.api!.projectUsesStyledJsx()).toBe(false);

    writeSource(linked, "src/Styled.jsx", "export default () => <style jsx>{css}</style>;");
    watchChange(path.join(fs.realpathSync(linked), "src/Styled.jsx"), "update");
    expect(await plugin.api!.projectUsesStyledJsx()).toBe(true);
  });

  it("checks the manifests again when the project's package.json changes", async () => {
    const root = createProject({ "pages/index.jsx": "export default () => <p>plain</p>;" });
    writeSource(root, "package.json", JSON.stringify({ name: "app", dependencies: {} }));
    const { plugin, invalidateModule, send, watchChange, loadDevModule } = startDevPlugin(root);
    expect(await plugin.api!.projectUsesStyledJsx()).toBe(false);
    expect(await loadDevModule()).toBe("export {};\n");

    // A dependency shipping styled-jsx precompiled is installed.
    writeSource(
      root,
      "node_modules/ui-kit/package.json",
      JSON.stringify({ name: "ui-kit", peerDependencies: { "styled-jsx": "5" } }),
    );
    writeSource(
      root,
      "package.json",
      JSON.stringify({ name: "app", dependencies: { "ui-kit": "1" } }),
    );
    watchChange(path.join(root, "package.json"), "update");

    expect(await plugin.api!.projectUsesStyledJsx()).toBe(true);
    await vi.waitFor(() => expect(invalidateModule).toHaveBeenCalledTimes(1));
    expect(send).toHaveBeenCalledWith({ type: "full-reload" });
  });

  // The usage regex also matches comments and strings, and vinext does not
  // require Next.js (or styled-jsx) to be installed. Loading the registration
  // there would fail, so a changed file only counts when styled-jsx resolves —
  // the same condition the startup scan applies.
  it("ignores styled-jsx-like source changes when styled-jsx is not installed", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-no-next-"));
    temporaryDirectories.push(root);
    writeSource(root, "package.json", '{"type":"module"}');
    writeSource(root, "pages/index.jsx", "export default () => <p>plain</p>;");
    const { plugin, invalidateModule, send, watchChange, loadDevModule } = startDevPlugin(root);

    expect(await plugin.api!.projectUsesStyledJsx()).toBe(false);
    expect(await loadDevModule()).toBe("export {};\n");

    writeSource(
      root,
      "pages/notes.jsx",
      "// TODO: try <style jsx> here\nexport default () => <p>notes</p>;",
    );
    watchChange(path.join(root, "pages/notes.jsx"));
    watchChange(path.join(root, "pages/notes.jsx"), "update");

    expect(await plugin.api!.projectUsesStyledJsx()).toBe(false);
    expect(await loadDevModule()).toBe("export {};\n");
    expect(invalidateModule).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
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

  // Every compiled `<style jsx>` renders `styled-jsx/style`, whether this
  // plugin compiled it or a dependency shipped it precompiled (and so is never
  // transformed here). Loading it on the server registers the Pages runtime.
  it("registers the Pages SSR runtime wherever styled-jsx/style is imported", async () => {
    const plugin = createStyledJsxPlugin(process.cwd());
    const resolveId = plugin.resolveId as ResolveIdHook;
    const rawStyle = requireFromNext.resolve("styled-jsx/style");
    const resolveIn = (
      environment: unknown,
      importer = "/app/node_modules/precompiled/index.js",
      kind?: string,
    ) =>
      resolveId.handler.call(
        { environment },
        "styled-jsx/style",
        importer,
        kind ? ({ kind } as { scan?: boolean }) : {},
      );
    const ssr = { name: "ssr", mode: "build", config: { consumer: "server" } };

    expect(resolveIn(ssr)).toBe("\0vinext-styled-jsx-style");
    expect(resolveIn(ssr, "/app/pages/index.jsx", "import-statement")).toBe(
      "\0vinext-styled-jsx-style",
    );
    // `require()` callers (CommonJS dependencies) get a CommonJS wrapper, so
    // `module.exports` stays the component whether or not they unwrap it.
    expect(resolveIn(ssr, "/app/node_modules/cjs/index.js", "require-call")).toBe(
      "\0vinext-styled-jsx-style-cjs",
    );
    // Not in the browser or RSC, and not for the wrappers' own requests (or
    // the registration's).
    expect(resolveIn({ name: "client", mode: "build", config: { consumer: "client" } })).toBe(
      rawStyle,
    );
    expect(resolveIn({ name: "rsc", mode: "build", config: { consumer: "server" } })).toBe(
      rawStyle,
    );
    expect(resolveIn(ssr, "\0vinext-styled-jsx-style")).toBe(rawStyle);
    expect(resolveIn(ssr, "\0vinext-styled-jsx-style-cjs", "require-call")).toBe(rawStyle);
    expect(resolveIn(ssr, "\0virtual:vinext-styled-jsx-ssr-registry")).toBe(rawStyle);

    const load = plugin.load as LoadHook;
    const wrapper = await load.handler("\0vinext-styled-jsx-style");
    expect(wrapper).toContain(SSR_REGISTRY_IMPORT);
    expect(wrapper).toContain('export { default } from "styled-jsx/style";');
    expect(await load.handler("\0vinext-styled-jsx-style-cjs")).toBe(
      'require("virtual:vinext-styled-jsx-ssr-registry");\n' +
        'module.exports = require("styled-jsx/style");\n',
    );
  });

  it("serves the SSR registry module that hands styled-jsx to vinext", async () => {
    const plugin = createStyledJsxPlugin(process.cwd());
    const resolveId = plugin.resolveId as ResolveIdHook;
    const load = plugin.load as LoadHook;

    const resolved = resolveId.handler("virtual:vinext-styled-jsx-ssr-registry");
    expect(resolved).toBe("\0virtual:vinext-styled-jsx-ssr-registry");
    const code = await load.handler(resolved!);
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

  it("exposes natively required styled-jsx through an ESM facade", async () => {
    const plugin = createStyledJsxPlugin(process.cwd());
    const resolveId = plugin.resolveId as ResolveIdHook;
    const load = plugin.load as LoadHook;
    const file = resolveId.handler("styled-jsx")!;

    const code = await load.handler(`\0vinext-styled-jsx-node:${file}`);

    const fileLiteral = JSON.stringify(file);
    expect(code).toContain(`createRequire(${fileLiteral})(${fileLiteral})`);
    expect(code).toContain("export default mod;");
    expect(code).toContain("export const StyleRegistry = mod.StyleRegistry;");
    expect(code).toContain("export const createStyleRegistry = mod.createStyleRegistry;");
  });

  // Next.js collects styled-jsx rules on every Pages render, including the
  // first one of a server instance, even when styled-jsx is only used by a
  // lazily loaded module. Server builds therefore load the registration up
  // front from every chunk that renders Pages without reaching it statically.
  describe("eager registration in server builds", () => {
    const REGISTRATION_ID = "\0virtual:vinext-styled-jsx-ssr-registry";
    const SHIM_ID = "/vinext/shims/styled-jsx-registry.js";

    type Chunk = {
      fileName: string;
      imports: string[];
      moduleIds: string[];
      isEntry?: boolean;
      isDynamicEntry?: boolean;
    };
    type RenderChunkHook = (
      this: unknown,
      code: string,
      chunk: Chunk & { isEntry: boolean; isDynamicEntry: boolean },
      outputOptions: { format: string },
      meta: { chunks: Record<string, Chunk> },
    ) => { code: string } | null;

    function chunk(fileName: string, options: Omit<Chunk, "fileName">): Chunk {
      return { fileName, ...options };
    }

    // entry → shared (shim); the only styled-jsx module is behind a dynamic
    // import. The request stage never renders Pages.
    const lazyGraph = [
      chunk("entry.js", { isEntry: true, imports: ["assets/shared.js"], moduleIds: ["/entry"] }),
      chunk("assets/shared.js", { imports: [], moduleIds: [SHIM_ID] }),
      chunk("assets/lazy.js", {
        isDynamicEntry: true,
        imports: ["assets/registration-impl.js"],
        moduleIds: ["/components/LazyStyled.jsx"],
      }),
      chunk("assets/registration.js", {
        isEntry: true,
        imports: ["assets/registration-impl.js"],
        moduleIds: [],
      }),
      chunk("assets/registration-impl.js", {
        imports: ["assets/shared.js"],
        moduleIds: [REGISTRATION_ID],
      }),
      chunk("assets/stage/response.js", {
        isDynamicEntry: true,
        imports: ["assets/shared.js"],
        moduleIds: ["/response-stage"],
      }),
      chunk("request.js", { isEntry: true, imports: [], moduleIds: ["/request-stage"] }),
    ];

    type BuildContext = ReturnType<typeof createBuildContext>;

    function createBuildContext(
      environment: object,
      registrationImporters: string[] = ["/components/LazyStyled.jsx"],
    ) {
      let emitted = 0;
      const emitFile = vi.fn(() => `registration-ref-${++emitted}`);
      return {
        environment,
        emitFile,
        // Emitted references belong to one build.
        getFileName: (referenceId: string) => {
          if (referenceId !== `registration-ref-${emitted}`) {
            throw new Error(`Unknown reference ${referenceId}`);
          }
          return "assets/registration.js";
        },
        getModuleInfo: (id: string) =>
          id === REGISTRATION_ID
            ? { importers: registrationImporters, dynamicImporters: [] as string[] }
            : null,
        resolve: async (source: string) =>
          source === "vinext/shims/styled-jsx-registry" ? { id: SHIM_ID, external: false } : null,
      };
    }

    function renderChunkWith(
      plugin: ReturnType<typeof createStyledJsxPlugin>,
      context: BuildContext,
      graph: Chunk[],
      fileName: string,
      format = "es",
    ) {
      const chunks = Object.fromEntries(graph.map((entry) => [entry.fileName, entry]));
      const target = chunks[fileName]!;
      return (plugin.renderChunk as RenderChunkHook).call(
        context,
        "export {};",
        { isEntry: false, isDynamicEntry: false, ...target },
        { format },
        { chunks },
      );
    }

    async function createServerBuild(options: { mode?: string; consumer?: string } = {}) {
      const plugin = createStyledJsxPlugin(process.cwd());
      const context = createBuildContext({
        mode: options.mode ?? "build",
        name: "ssr",
        config: { consumer: options.consumer ?? "server" },
      });
      (plugin.buildStart as (this: unknown) => void).call(context);
      const code = await (plugin.load as LoadHook).handler.call(context, REGISTRATION_ID);
      expect(code).toContain("registerStyledJsxRuntime(");
      const renderChunk = (graph: Chunk[], fileName: string, format = "es") =>
        renderChunkWith(plugin, context, graph, fileName, format);
      return { emitFile: context.emitFile, renderChunk };
    }

    it("emits the registration as its own chunk only in server builds", async () => {
      const build = await createServerBuild();
      expect(build.emitFile).toHaveBeenCalledWith({
        type: "chunk",
        id: "virtual:vinext-styled-jsx-ssr-registry",
        name: "styled-jsx-registry",
      });
      expect((await createServerBuild({ mode: "dev" })).emitFile).not.toHaveBeenCalled();
      expect((await createServerBuild({ consumer: "client" })).emitFile).not.toHaveBeenCalled();
    });

    it("imports the registration from chunks that render Pages but reach it only lazily", async () => {
      const { renderChunk } = await createServerBuild();

      expect(renderChunk(lazyGraph, "entry.js")?.code).toBe(
        'export {};\nimport "./assets/registration.js";\n',
      );
      // A dynamically imported render root (a multi-stage response stage).
      expect(renderChunk(lazyGraph, "assets/stage/response.js")?.code).toBe(
        'export {};\nimport "../registration.js";\n',
      );
      // Chunks that already load it, and ones that never render Pages.
      expect(renderChunk(lazyGraph, "assets/lazy.js")).toBeNull();
      expect(renderChunk(lazyGraph, "assets/registration.js")).toBeNull();
      expect(renderChunk(lazyGraph, "request.js")).toBeNull();
      expect(renderChunk(lazyGraph, "assets/shared.js")).toBeNull();
      expect(renderChunk(lazyGraph, "entry.js", "cjs")).toBeNull();

      // styled-jsx used by a module the entry loads statically: nothing to add.
      const staticGraph = lazyGraph.map((entry) =>
        entry.fileName === "entry.js"
          ? { ...entry, imports: [...entry.imports, "assets/registration-impl.js"] }
          : entry,
      );
      expect(renderChunk(staticGraph, "entry.js")).toBeNull();
    });

    // A watch rebuild can restore unchanged modules — the registration among
    // them — from the module cache without rerunning `load`.
    it("keeps entries importing the registration across cached watch rebuilds", async () => {
      const plugin = createStyledJsxPlugin(process.cwd());
      const environment = { mode: "build", name: "ssr", config: { consumer: "server" } };
      const buildStart = plugin.buildStart as (this: unknown) => void;
      const expected = 'export {};\nimport "./assets/registration.js";\n';

      const first = createBuildContext(environment);
      buildStart.call(first);
      await (plugin.load as LoadHook).handler.call(first, REGISTRATION_ID);
      expect(renderChunkWith(plugin, first, lazyGraph, "entry.js")?.code).toBe(expected);

      // Second build: an unrelated module changed; `load` is not called again.
      const second = createBuildContext(environment);
      buildStart.call(second);
      expect(second.emitFile).toHaveBeenCalledTimes(1);
      expect(renderChunkWith(plugin, second, lazyGraph, "entry.js")?.code).toBe(expected);

      // A rebuild that reruns `load` does not emit the chunk twice.
      const third = createBuildContext(environment);
      buildStart.call(third);
      await (plugin.load as LoadHook).handler.call(third, REGISTRATION_ID);
      expect(third.emitFile).toHaveBeenCalledTimes(1);

      // A rebuild after the last styled-jsx module was removed: the chunk is
      // emitted up front, but nothing imports the registration any more.
      const fourth = createBuildContext(environment, []);
      buildStart.call(fourth);
      expect(renderChunkWith(plugin, fourth, lazyGraph, "entry.js")).toBeNull();
    });

    it("leaves builds that never loaded the registration untouched", () => {
      const plugin = createStyledJsxPlugin(process.cwd());
      const chunks = Object.fromEntries(lazyGraph.map((entry) => [entry.fileName, entry]));
      expect(
        (plugin.renderChunk as RenderChunkHook).call(
          { environment: { mode: "build", name: "ssr", config: { consumer: "server" } } },
          "export {};",
          { isDynamicEntry: false, ...lazyGraph[0]!, isEntry: true },
          { format: "es" },
          { chunks },
        ),
      ).toBeNull();
    });
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
    const pagesPageData = await import("../packages/vinext/src/server/pages-page-data.js");
    const pagesPageResponse = await import("../packages/vinext/src/server/pages-page-response.js");
    return { registry, documentProps, pagesStyledJsx, pagesPageData, pagesPageResponse };
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
    expect(result.styledJsxHTML).toBe("");
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
    // `styles` belong to the head; Next.js still emits the unflushed registry
    // (`styledJsxInsertedHTML`) immediately before the React root, so it is
    // returned separately for the caller to place there.
    expect(result.stylesHTML).toBe('<style id="document-style"></style>');
    expect(result.styledJsxHTML).toBe('<style id="__jsx-abc">p.jsx-abc{color:red}</style>');
  });

  // Regeneration splices a fresh body into the cached document. Interpolated
  // rules get a new id whenever the data changes, and rules the new render no
  // longer registers must stop applying, so every cached page rule is swapped
  // for the regenerated render's.
  function regenerateIsrHtml(
    pagesPageData: typeof import("../packages/vinext/src/server/pages-page-data.js"),
    cachedHtml: string,
    page: React.ReactElement,
  ) {
    return pagesPageData.renderPagesIsrHtml({
      buildId: "build-123",
      cachedHtml,
      createPageElement: () => page,
      i18n: { locale: "en", locales: ["en"], defaultLocale: "en", domainLocales: [] },
      pageProps: {},
      params: {},
      renderIsrPassToStringAsync: (element: React.ReactNode) =>
        renderToString(React.createElement(React.Fragment, null, element)),
      routePattern: "/isr",
      safeJsonStringify: JSON.stringify,
    });
  }

  it("refreshes styled-jsx rules when ISR regeneration re-renders the body", async () => {
    const { registry, pagesPageData } = await loadRegisteredRuntime();
    registry.registerStyledJsxRuntime(styledJsx);
    const staleShell = '<style id="__jsx-old">p.jsx-old{color:red}</style>';
    const staleLate = '<style id="__jsx-late">p.jsx-late{color:red}</style>';

    const html = await regenerateIsrHtml(
      pagesPageData,
      `<!DOCTYPE html><html><head><title>t</title></head><body>` +
        `<style id="user-style">.user{}</style>${staleShell}<div id="__next"><p class="jsx-old">stale</p></div>` +
        `${staleLate}\n  <script id="__NEXT_DATA__" type="application/json">{"old":1}</script></body></html>`,
      styledElement("p.jsx-new{color:blue}", "new"),
    );

    expect(html).toContain(
      '<style id="user-style">.user{}</style>' +
        '<style id="__jsx-new">p.jsx-new{color:blue}</style>' +
        '<div id="__next"><div><p class="jsx-new">styled</p></div>',
    );
    expect(html).toContain('</div></div>\n  <script id="__NEXT_DATA__"');
    expect(html).not.toContain("jsx-old");
    expect(html).not.toContain("jsx-late");
  });

  // A custom `_document` using `Document.getInitialProps(ctx)` puts the page's
  // rules in <head> (via `ctx.defaultGetInitialProps()`), next to styles it
  // owns. Regeneration does not re-render `_document`, so it must tell those
  // apart: a page rule the new render dropped goes, document styles stay.
  it("removes head-flushed page rules that ISR regeneration no longer renders", async () => {
    const { registry, pagesPageData } = await loadRegisteredRuntime();
    registry.registerStyledJsxRuntime(styledJsx);
    const documentStyles =
      '<style data-styled="">.sc{}</style><style data-manual-document-style="">.manual{}</style>';
    const staleGlobal = '<style id="__jsx-global">body{background:red}</style>';
    const pageRule = '<style id="__jsx-page">p.jsx-page{color:green}</style>';

    const html = await regenerateIsrHtml(
      pagesPageData,
      `<!DOCTYPE html><html><head><meta name="document-child" content="1"/>` +
        `${staleGlobal}${pageRule}${documentStyles}</head><body>` +
        `<div id="__next"><div><p class="jsx-page">styled</p></div></div>` +
        `\n  <script id="__NEXT_DATA__" type="application/json">{"old":1}</script></body></html>`,
      // The regenerated render no longer includes the `<style jsx global>`.
      styledElement("p.jsx-page{color:green}", "page"),
    );

    expect(html).not.toContain("background:red");
    // The page's remaining rule stays in <head>, once, where it was rendered.
    expect(html).toContain(
      `<meta name="document-child" content="1"/>${pageRule}${documentStyles}</head>`,
    );
    expect(html.match(/id="__jsx-page"/g)).toHaveLength(1);
    expect(html).toContain('<body><div id="__next"><div><p class="jsx-page">styled</p>');
  });

  // The response and the ISR cache write read separate branches of the body
  // stream; whichever finishes first flushes the late rules, and both copies
  // must carry them.
  it("writes late Suspense rules into both the response and the ISR cache copy", async () => {
    const { registry, pagesPageResponse } = await loadRegisteredRuntime();
    registry.registerStyledJsxRuntime(styledJsx);
    const LateStyled = React.lazy(
      () =>
        new Promise<{ default: React.ComponentType }>((resolve) => {
          setTimeout(
            () => resolve({ default: () => styledElement("p.jsx-late{color:blue}", "late") }),
            10,
          );
        }),
    );
    const isrSet = vi.fn(async (_key: string, _value: { html?: string }) => {});

    const response = await pagesPageResponse.renderPagesPageResponse({
      assetTags: "",
      buildId: "build-123",
      clearSsrContext() {},
      createPageElement: () =>
        React.createElement(
          React.Fragment,
          null,
          styledElement("p.jsx-shell{color:red}", "shell"),
          React.createElement(React.Suspense, { fallback: null }, React.createElement(LateStyled)),
        ),
      disableOptimizedLoading: false,
      DocumentComponent: null,
      fontLinkHeader: "",
      fontPreloads: [],
      getFontLinks: () => [],
      getFontStyles: () => [],
      gsspRes: null,
      i18n: { locale: "en", locales: ["en"], defaultLocale: "en", domainLocales: [] },
      isrCacheKey: (_router, pathname) => `pages:${pathname}`,
      isrRevalidateSeconds: 60,
      isrSet,
      pageProps: {},
      params: {},
      renderDocumentToString: async () => "",
      renderToReadableStream,
      routePattern: "/late",
      routeUrl: "/late",
      safeJsonStringify: JSON.stringify,
    });
    const html = await response.text();
    await vi.waitFor(() => expect(isrSet).toHaveBeenCalledTimes(1));
    const cachedHtml = isrSet.mock.calls[0]?.[1].html ?? "";

    for (const document of [html, cachedHtml]) {
      expect(document).toContain(
        '<style id="__jsx-shell">p.jsx-shell{color:red}</style><div id="__next">',
      );
      expect(document).toContain('</div><style id="__jsx-late">p.jsx-late{color:blue}</style>');
      expect(document.match(/id="__jsx-/g)).toHaveLength(2);
    }
  });
});
