import { describe, expect, it } from "vite-plus/test";
import {
  createCssModuleImportCompatibilityPlugin,
  rewriteCssModuleNamespaceImports,
} from "../packages/vinext/src/plugins/css-module-imports.js";

describe("CSS Module import compatibility", () => {
  it("rewrites namespace CSS Module imports to the default locals object", () => {
    const source = [
      'import * as css from "./styles.module.css";',
      'import * as scss from "example/index.module.scss";',
      'import * as sass from "./styles.module.sass";',
    ].join("\n");

    expect(rewriteCssModuleNamespaceImports(source)?.code).toBe(
      [
        'import css from "./styles.module.css";',
        'import scss from "example/index.module.scss";',
        'import sass from "./styles.module.sass";',
      ].join("\n"),
    );
  });

  it("parses imports from TSX modules", () => {
    const source = [
      'import * as classes from "example/index.module.scss";',
      'export default function Page(): React.ReactNode { return <div className={classes["red-text"]} />; }',
    ].join("\n");

    expect(rewriteCssModuleNamespaceImports(source, "tsx")?.code).toContain(
      'import classes from "example/index.module.scss";',
    );
  });

  it("selects the TypeScript parser for uppercase extensions", () => {
    const plugin = createCssModuleImportCompatibilityPlugin();
    const transform =
      typeof plugin.transform === "function" ? plugin.transform : plugin.transform?.handler;
    const source = [
      'import * as classes from "example/index.module.scss";',
      'export default function Page(): React.ReactNode { return <div className={classes["red-text"]} />; }',
    ].join("\n");

    expect(transform?.call({} as never, source, "/project/Page.TSX")).toMatchObject({
      code: expect.stringContaining('import classes from "example/index.module.scss";'),
    });
  });

  it("parses imports from .js modules containing JSX", () => {
    const source = [
      'import * as classes from "example/index.module.scss";',
      'export default function Page() { return <div className={classes["red-text"]} />; }',
    ].join("\n");

    expect(rewriteCssModuleNamespaceImports(source, "jsx")?.code).toContain(
      'import classes from "example/index.module.scss";',
    );
  });

  it("uses the AST binding for commented namespace imports", () => {
    const source = 'import * /* webpack */ as styles from "./styles.module.scss";';

    expect(rewriteCssModuleNamespaceImports(source)?.code).toBe(
      'import styles from "./styles.module.scss";',
    );
  });

  it("rewrites namespace imports after MDX compilation", async () => {
    const { default: mdx } = await import("@mdx-js/rollup");
    const mdxPlugin = mdx() as {
      config: (config: unknown, env: unknown) => void;
      transform: (code: string, id: string) => Promise<string | { code: string } | undefined>;
    };
    mdxPlugin.config({}, { command: "build", mode: "production" });
    const compiled = await mdxPlugin.transform.call(
      {} as never,
      'import * as styles from "./styles.module.scss";\n\n# Hello',
      "/project/page.mdx",
    );
    expect(compiled).toBeTruthy();

    const compatibilityPlugin = createCssModuleImportCompatibilityPlugin({ compiledMdx: true });
    expect(compatibilityPlugin.enforce).toBe("post");
    const compatibilityTransform =
      typeof compatibilityPlugin.transform === "function"
        ? compatibilityPlugin.transform
        : compatibilityPlugin.transform?.handler;
    const result = await compatibilityTransform?.call(
      {} as never,
      typeof compiled === "string" ? compiled : compiled!.code,
      "/project/page.mdx",
    );

    expect(result && typeof result !== "string" ? result.code : result).toContain(
      'import styles from "./styles.module.scss";',
    );
  });

  it("leaves existing default, named, dynamic, and non-module imports unchanged", () => {
    const source = [
      'import styles from "./styles.module.scss";',
      'import { red } from "./styles.module.scss";',
      'const lazy = import("./styles.module.scss");',
      'import * as inlineCss from "./styles.module.css?inline";',
      'import * as rawScss from "./styles.module.scss?raw";',
      'import type * as styleTypes from "./styles.module.scss";',
      'import * as attributed from "./styles.module.css" with { type: "css" };',
      'import * as globalStyles from "./styles.scss";',
      'import * as packageModule from "example";',
    ].join("\n");

    expect(rewriteCssModuleNamespaceImports(source)).toBeNull();
  });
});
