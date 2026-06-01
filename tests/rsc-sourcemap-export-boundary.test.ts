import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createBuilder } from "vite";
import { describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";
import { repairSourceMappingCommentStatementBoundary } from "../packages/vinext/src/plugins/rsc-sourcemap-comment-boundary.js";

const SOURCE_MAPPING_COMMENT = "//# sourceMapping" + "URL=";

async function withTempDir<T>(prefix: string, run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

function writeFixtureFile(root: string, filePath: string, content: string) {
  const absPath = path.join(root, filePath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content);
}

async function buildApp(root: string) {
  const rscOutDir = path.join(root, "dist", "server");
  const ssrOutDir = path.join(root, "dist", "server", "ssr");
  const clientOutDir = path.join(root, "dist", "client");
  const builder = await createBuilder({
    root,
    configFile: false,
    plugins: [vinext({ appDir: root, rscOutDir, ssrOutDir, clientOutDir })],
    logLevel: "silent",
  });
  await builder.buildApp();
}

describe("RSC CSS export transform", () => {
  it("repairs export statements appended to source map comments", () => {
    const code = `let getHTMLDiffComponents = () => null;
${SOURCE_MAPPING_COMMENT}index.js.mapexport { getHTMLDiffComponents };
`;

    expect(repairSourceMappingCommentStatementBoundary(code))
      .toBe(`let getHTMLDiffComponents = () => null;
${SOURCE_MAPPING_COMMENT}index.js.map
export { getHTMLDiffComponents };
`);
  });

  it("preserves re-exported values when a CSS-importing module ends with a source map comment", async () => {
    await withTempDir("vinext-rsc-sourcemap-export-", async (root) => {
      fs.symlinkSync(
        path.resolve(import.meta.dirname, "../node_modules"),
        path.join(root, "node_modules"),
        "junction",
      );

      writeFixtureFile(
        root,
        "package.json",
        JSON.stringify({ name: "vinext-rsc-sourcemap-export", private: true, type: "module" }),
      );
      writeFixtureFile(root, "next.config.mjs", "export default {};\n");
      writeFixtureFile(
        root,
        "app/layout.tsx",
        `export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html><body>{children}</body></html>;
}
`,
      );
      writeFixtureFile(
        root,
        "app/page.tsx",
        `import { getHTMLDiffComponents } from "../lib/rsc.js";

export default function Page() {
  const components = getHTMLDiffComponents();
  return <main>{components.From} {components.To}</main>;
}
`,
      );
      writeFixtureFile(
        root,
        "lib/rsc.js",
        `export { getHTMLDiffComponents } from "./HTMLDiff/index.js";
`,
      );
      writeFixtureFile(
        root,
        "lib/HTMLDiff/index.js",
        `import "./index.scss";

export const getHTMLDiffComponents = () => ({ From: "from", To: "to" });
${SOURCE_MAPPING_COMMENT}index.js.map`,
      );
      writeFixtureFile(root, "lib/HTMLDiff/index.scss", ".html-diff { color: red; }\n");

      await buildApp(root);
    });
  }, 120_000);
});
