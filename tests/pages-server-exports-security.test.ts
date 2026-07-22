/**
 * Security regression: Pages Router data-fetching modules must never enter the
 * browser graph, including when the export is forwarded from another file.
 *
 * Ported from Next.js: test/unit/babel-plugin-next-ssg-transform.test.ts
 * https://github.com/vercel/next.js/blob/canary/test/unit/babel-plugin-next-ssg-transform.test.ts
 */
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createBuilder } from "vite";

const CLIENT_SECRET = "VINEXT_CLIENT_BUNDLE_SECRET_SENTINEL_6f28d81e";
let tmpDir: string;
const workspaceRoot = path.resolve(import.meta.dirname, "..");

async function writeFile(file: string, source: string): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, source, "utf8");
}

async function collectJavaScript(dir: string): Promise<string> {
  const files = await fsp.readdir(dir, { recursive: true, withFileTypes: true });
  const sources = await Promise.all(
    files
      .filter((entry) => entry.isFile() && /\.[cm]?js$/.test(entry.name))
      .map((entry) => fsp.readFile(path.join(entry.parentPath, entry.name), "utf8")),
  );
  return sources.join("\n");
}

async function buildPagesFixture(
  pageSource: string,
  prefix: string,
  pagePath = path.join("pages", "index.tsx"),
): Promise<string> {
  const fixtureDir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  await writeFile(path.join(fixtureDir, pagePath), pageSource);
  await fsp.symlink(
    path.join(workspaceRoot, "node_modules"),
    path.join(fixtureDir, "node_modules"),
    "junction",
  );
  const { default: vinext } = await import(
    pathToFileURL(path.join(workspaceRoot, "packages/vinext/src/index.ts")).href
  );
  const builder = await createBuilder({
    root: fixtureDir,
    configFile: false,
    plugins: [
      vinext({
        appDir: fixtureDir,
        rscOutDir: path.join(fixtureDir, "dist", "server"),
        ssrOutDir: path.join(fixtureDir, "dist", "server", "ssr"),
        clientOutDir: path.join(fixtureDir, "dist", "client"),
      }),
    ],
    logLevel: "error",
  });
  await builder.buildApp();
  return fixtureDir;
}

beforeAll(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-pages-server-export-security-"));

  await writeFile(
    path.join(tmpDir, "pages", "index.tsx"),
    `export { getServerSideProps } from "../server/page-data";

export default function Page() {
  return <h1>safe page</h1>;
}
`,
  );
  await writeFile(
    path.join(tmpDir, "pages", "direct.tsx"),
    `import { readSecret } from "../server/secret";

export async function getStaticProps() {
  return { props: { secret: readSecret() } };
}

export default function DirectPage() {
  return <h1>direct page</h1>;
}
`,
  );
  await writeFile(
    path.join(tmpDir, "pages", "admin", "_error.tsx"),
    `import { readSecret } from "../../server/secret";

export async function getStaticProps() {
  return { props: { secret: readSecret() } };
}

export default function NestedErrorPage() {
  return <h1>nested error route</h1>;
}
`,
  );
  await writeFile(
    path.join(tmpDir, "pages", "mdx-data.mdx"),
    `import { readSecret } from "../server/secret"

export async function getStaticProps() {
  return { props: { secret: readSecret() } }
}

# MDX data page
`,
  );
  await writeFile(
    path.join(tmpDir, "server", "page-data.ts"),
    `import "server-only";
import { readSecret } from "./secret";

export async function getServerSideProps() {
  return { props: { secret: readSecret() } };
}
`,
  );
  await writeFile(
    path.join(tmpDir, "server", "secret.ts"),
    `export function readSecret() {
  return "${CLIENT_SECRET}";
}
`,
  );
  await fsp.symlink(
    path.join(workspaceRoot, "node_modules"),
    path.join(tmpDir, "node_modules"),
    "junction",
  );

  const { default: vinext } = await import(
    pathToFileURL(path.join(workspaceRoot, "packages/vinext/src/index.ts")).href
  );
  const builder = await createBuilder({
    root: tmpDir,
    configFile: false,
    plugins: [
      vinext({
        appDir: tmpDir,
        nextConfig: { pageExtensions: ["tsx", "ts", "mdx"] },
        rscOutDir: path.join(tmpDir, "dist", "server"),
        ssrOutDir: path.join(tmpDir, "dist", "server", "ssr"),
        clientOutDir: path.join(tmpDir, "dist", "client"),
      }),
    ],
    logLevel: "error",
  });

  await builder.buildApp();
}, 120_000);

afterAll(async () => {
  if (tmpDir) await fsp.rm(tmpDir, { recursive: true, force: true });
});

describe("Pages Router server export isolation", () => {
  it("does not include direct or re-exported server modules and secrets in client assets", async () => {
    const clientJavaScript = await collectJavaScript(path.join(tmpDir, "dist", "client"));
    expect(clientJavaScript).not.toContain(CLIENT_SECRET);
    expect(clientJavaScript).not.toContain("server-only");
    expect(clientJavaScript).not.toContain("readSecret");
  });

  it("rejects page export-all declarations with the Next.js error", async () => {
    const pageSource = `
export * from "./other";
export default function Page() { return null; }
`;
    await expect(buildPagesFixture(pageSource, "vinext-pages-export-all-parity-")).rejects.toThrow(
      "Using `export * from '...'` in a page is disallowed. Please use `export { default } from '...'` instead.",
    );
  });

  it.each([path.join("pages", "api.ts"), path.join("pages", "api", "index.ts")])(
    "allows export-all declarations in API page file %s",
    async (pagePath) => {
      const pageSource = `
export * from "node:path";
export default function handler() {}
`;
      const fixtureDir = await buildPagesFixture(
        pageSource,
        "vinext-pages-api-export-all-parity-",
        pagePath,
      );
      await fsp.rm(fixtureDir, { recursive: true, force: true });
    },
  );

  it("rejects mixed SSR and SSG exports with the Next.js error", async () => {
    const pageSource = `
export function getServerSideProps() { return { props: {} }; }
export function getStaticProps() { return { props: {} }; }
export default function Page() { return null; }
`;
    await expect(buildPagesFixture(pageSource, "vinext-pages-mixed-data-parity-")).rejects.toThrow(
      "You can not use getStaticProps or getStaticPaths with getServerSideProps. To use SSG, please remove getServerSideProps",
    );
  });
});
