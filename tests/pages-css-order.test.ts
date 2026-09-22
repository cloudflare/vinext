import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createBuilder } from "vite-plus";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";

const ROOT_NODE_MODULES = path.resolve(import.meta.dirname, "../node_modules");

async function writeFixtureFile(root: string, file: string, source: string): Promise<void> {
  const filePath = path.join(root, file);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, source, "utf8");
}

describe("Pages Router production CSS order", () => {
  type CssGraph = Record<string, { imports?: string[]; css?: string[] }>;

  let root: string;
  let server: import("node:http").Server;
  let url: string;
  let emittedCssGraph: CssGraph;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-pages-css-order-"));
    await fs.symlink(ROOT_NODE_MODULES, path.join(root, "node_modules"), "junction");
    await writeFixtureFile(root, "package.json", JSON.stringify({ type: "module" }));
    await writeFixtureFile(
      root,
      "components/base.module.css",
      `.panel { --css-order: base; visibility: hidden; }\n`,
    );
    await writeFixtureFile(
      root,
      "components/Panel.tsx",
      `import styles from "./base.module.css";
export default function Panel({ children, className }: { children: React.ReactNode; className?: string }) {
  return <section id="panel" className={styles.panel + " " + (className ?? "")}>{children}</section>;
}
`,
    );
    await writeFixtureFile(
      root,
      "components/dynamic-override.module.css",
      `.override { --dynamic-css-order: override; color: green; }\n`,
    );
    await writeFixtureFile(
      root,
      "components/DynamicPanel.tsx",
      `import Panel from "./Panel";
import styles from "./dynamic-override.module.css";
export default function DynamicPanel() {
  return <Panel className={styles.override}>Dynamic CSS fixture</Panel>;
}
`,
    );
    await writeFixtureFile(
      root,
      "components/no-ssr.module.css",
      `.noSsr { --dynamic-css-order: no-ssr; }\n`,
    );
    await writeFixtureFile(
      root,
      "components/NoSsrPanel.tsx",
      `import styles from "./no-ssr.module.css";
export default function NoSsrPanel() { return <p className={styles.noSsr}>No SSR CSS fixture</p>; }
`,
    );
    await writeFixtureFile(
      root,
      "pages/reset.module.css",
      `.reset { --css-order: reset; visibility: visible; }\n`,
    );
    await writeFixtureFile(
      root,
      "pages/_app.tsx",
      `import Panel from "../components/Panel";
import styles from "./reset.module.css";
export default function App({ Component, pageProps }) {
  return <Panel className={styles.reset}><Component {...pageProps} /></Panel>;
}
`,
    );
    await writeFixtureFile(
      root,
      "pages/index.tsx",
      `import dynamic from "next/dynamic";
const DynamicPanel = dynamic(() => import("../components/DynamicPanel"));
const NoSsrPanel = dynamic(() => import("../components/NoSsrPanel"), { ssr: false });
export default function Page() {
  return <><p>CSS order fixture</p><DynamicPanel /><NoSsrPanel /></>;
}
`,
    );
    await writeFixtureFile(
      root,
      "pages/other.tsx",
      `import Panel from "../components/Panel";
export default function Other() { return <Panel>Other page</Panel>; }
`,
    );

    const builder = await createBuilder({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [vinext({ disableAppRouter: true })],
    });
    await builder.buildApp();

    const sidecar = (await import(
      pathToFileURL(path.join(root, "dist", "vinext-client-assets.js")).href
    )) as { default: { cssGraph?: CssGraph } };
    emittedCssGraph = sidecar.default.cssGraph ?? {};

    const { startProdServer } = await import("../packages/vinext/src/server/prod-server.js");
    const started = await startProdServer({
      port: 0,
      host: "127.0.0.1",
      outDir: path.join(root, "dist"),
    });
    server = "server" in started ? started.server : started;
    const address = server.address() as { port: number };
    url = `http://127.0.0.1:${address.port}`;
  }, 60_000);

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  // Ported from Next.js: test/e2e/css-features/css-modules-ordering.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/css-features/css-modules-ordering.test.ts
  it("links static and rendered dynamic CSS in dependency order", async () => {
    const appEntry = Object.entries(emittedCssGraph).find(([key]) =>
      key.endsWith("pages/_app.tsx"),
    )?.[1];
    expect(appEntry?.imports).not.toHaveLength(0);
    expect(appEntry?.css).not.toHaveLength(0);

    const response = await fetch(url);
    expect(response.status).toBe(200);
    const html = await response.text();
    const stylesheetHrefs = Array.from(
      html.matchAll(/<link rel="stylesheet"[^>]* href="([^"]+)"/g),
      (match) => match[1]!,
    );
    const stylesheets = await Promise.all(
      stylesheetHrefs.map(async (href) => {
        const pathname = new URL(href, url).pathname.replace(/^\//, "");
        return fs.readFile(path.join(root, "dist", "client", pathname), "utf8");
      }),
    );
    const baseIndex = stylesheets.findIndex((css) => css.includes("--css-order:base"));
    const resetIndex = stylesheets.findIndex((css) => css.includes("--css-order:reset"));
    const baseLastIndex = stylesheets
      .map((css) => css.includes("--css-order:base"))
      .lastIndexOf(true);
    const dynamicOverrideIndex = stylesheets.findIndex((css) =>
      css.includes("--dynamic-css-order:override"),
    );
    const noSsrIndex = stylesheets.findIndex((css) => css.includes("--dynamic-css-order:no-ssr"));

    expect(html).toContain("CSS order fixture");
    expect(html).toContain("Dynamic CSS fixture");
    expect(html).not.toContain("No SSR CSS fixture");
    expect(baseIndex).toBeGreaterThanOrEqual(0);
    expect(resetIndex).toBeGreaterThanOrEqual(0);
    expect(dynamicOverrideIndex).toBeGreaterThanOrEqual(0);
    expect(noSsrIndex).toBe(-1);
    expect(stylesheets.filter((css) => css.includes("--css-order:base"))).toHaveLength(1);
    expect(baseLastIndex).toBeLessThan(resetIndex);
    expect(baseLastIndex).toBeLessThan(dynamicOverrideIndex);
  });
});
