import { describe, expect, it } from "vite-plus/test";
import { rewriteCssModuleNamespaceImports } from "../packages/vinext/src/plugins/css-module-imports.js";

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

  it("parses imports from .js modules containing JSX", () => {
    const source = [
      'import * as classes from "example/index.module.scss";',
      'export default function Page() { return <div className={classes["red-text"]} />; }',
    ].join("\n");

    expect(rewriteCssModuleNamespaceImports(source, "jsx")?.code).toContain(
      'import classes from "example/index.module.scss";',
    );
  });

  it("leaves existing default, named, dynamic, and non-module imports unchanged", () => {
    const source = [
      'import styles from "./styles.module.scss";',
      'import { red } from "./styles.module.scss";',
      'const lazy = import("./styles.module.scss");',
      'import * as inlineCss from "./styles.module.css?inline";',
      'import * as rawScss from "./styles.module.scss?raw";',
      'import * as globalStyles from "./styles.scss";',
      'import * as packageModule from "example";',
    ].join("\n");

    expect(rewriteCssModuleNamespaceImports(source)).toBeNull();
  });
});
