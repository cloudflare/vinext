import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

const repoRoot = path.resolve(import.meta.dirname, "..");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-styled-jsx-types-"));

beforeAll(() => {
  execFileSync("vp", ["run", "vinext#build"], {
    cwd: repoRoot,
    stdio: "pipe",
  });

  const packageTarball = execFileSync(
    "npm",
    ["pack", "--ignore-scripts", "--pack-destination", tempDir],
    {
      cwd: path.join(repoRoot, "packages/vinext"),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).trim();
  const packageDir = path.join(tempDir, "node_modules/vinext");
  fs.mkdirSync(packageDir, { recursive: true });
  execFileSync(
    "tar",
    ["-xzf", path.join(tempDir, packageTarball), "-C", packageDir, "--strip-components=1"],
    { stdio: "pipe" },
  );
  fs.mkdirSync(path.join(packageDir, "node_modules"), { recursive: true });
  fs.symlinkSync(
    path.join(repoRoot, "packages/vinext/node_modules/styled-jsx"),
    path.join(packageDir, "node_modules/styled-jsx"),
    "dir",
  );
  fs.mkdirSync(path.join(tempDir, "node_modules/@vitejs"), { recursive: true });
  fs.symlinkSync(
    path.join(repoRoot, "packages/vinext/node_modules/@vitejs/plugin-react"),
    path.join(tempDir, "node_modules/@vitejs/plugin-react"),
    "dir",
  );
  fs.symlinkSync(
    path.join(repoRoot, "packages/vinext/node_modules/vite"),
    path.join(tempDir, "node_modules/vite"),
    "dir",
  );
  fs.mkdirSync(path.join(tempDir, "node_modules/@types"), { recursive: true });
  fs.symlinkSync(
    path.join(repoRoot, "node_modules/@types/react"),
    path.join(tempDir, "node_modules/@types/react"),
    "dir",
  );
  fs.writeFileSync(path.join(tempDir, "package.json"), '{"type":"module"}\n');
}, 120_000);

afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function compileConsumer(fileName: string, source: string): readonly ts.Diagnostic[] {
  const consumerPath = path.join(tempDir, fileName);
  fs.writeFileSync(consumerPath, source);

  const program = ts.createProgram([consumerPath], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    jsx: ts.JsxEmit.Preserve,
    strict: true,
    noEmit: true,
    skipLibCheck: false,
  });

  return ts.getPreEmitDiagnostics(program);
}

describe("styled-jsx public types", () => {
  it("compiles transformed and direct usage from the packed package", () => {
    const diagnostics = compileConsumer(
      "consumer.tsx",
      `import "vinext";
import { createStyleRegistry, style, useStyleRegistry } from "styled-jsx";
import type {
  StyledJsxStyleProps,
  StyledJsxStyleRegistry,
  StyleRegistryInstance,
} from "styled-jsx";
import JSXStyle from "styled-jsx/style";
import css from "styled-jsx/css";
import type { JSX } from "react";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2) ? true : false;
type Assert<Value extends true> = Value;
type CssExport = Assert<Equal<typeof import("styled-jsx/css"), typeof css>>;
type RegistryAlias = Assert<Equal<StyleRegistryInstance, StyledJsxStyleRegistry>>;

const registry: StyledJsxStyleRegistry = createStyleRegistry();
registry.add({ id: "consumer-style", children: "p { color: red }" });
registry.remove({ id: "consumer-style", children: "p { color: red }" });

const hookRegistry: StyledJsxStyleRegistry = useStyleRegistry();
hookRegistry.add(null);
hookRegistry.remove(null);

const styles = css\`p { color: red }\`;
const globalStyles = css.global\`body { margin: 0 }\`;
const resolved = css.resolve\`p { color: red }\`;
const dynamicValues: StyledJsxStyleProps["dynamic"] = ["red", 2, false, null];
const dynamicClassName = style.dynamic([
  ["consumer-style", dynamicValues ?? []],
]);
type CssReturn = Assert<Equal<typeof styles, JSX.Element>>;
type GlobalReturn = Assert<Equal<typeof globalStyles, JSX.Element>>;
type ResolveReturn = Assert<
  Equal<typeof resolved, { className: string; styles: JSX.Element }>
>;

export type StyledJsxAssertions =
  | CssExport
  | CssReturn
  | GlobalReturn
  | RegistryAlias
  | ResolveReturn;

export function Consumer() {
  return (
    <>
      <style jsx global>{\`p { color: red }\`}</style>
      <JSXStyle id="consumer-style" dynamic={dynamicValues}>
        {resolved.styles}
      </JSXStyle>
      <p
        className={\`\${resolved.className} \${dynamicClassName}\`}
        data-style-component={typeof style}
      >
        styled-jsx consumer
      </p>
    </>
  );
}
`,
    );

    expect(
      diagnostics.map((diagnostic) =>
        ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
      ),
    ).toEqual([]);
  }, 30_000);

  it("does not claim the unsupported styled-jsx babel subpath", () => {
    const diagnostics = compileConsumer(
      "unsupported.ts",
      `import "vinext";
import plugin from "styled-jsx/babel";
void plugin;
`,
    );

    expect(
      diagnostics.some(
        (diagnostic) =>
          diagnostic.code === 2307 &&
          ts
            .flattenDiagnosticMessageText(diagnostic.messageText, "\n")
            .includes("styled-jsx/babel"),
      ),
    ).toBe(true);
  }, 30_000);
});
