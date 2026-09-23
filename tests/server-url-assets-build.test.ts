/**
 * Build-level scoping for `vinext:server-url-assets`.
 *
 * Server code fetches `new URL(<file>, import.meta.url)` assets, so their bytes
 * ship in the server bundle (see tests/server-url-assets.test.ts). Client
 * components only reference browser assets, so their files must not be
 * inlined into server or Worker output:
 *   - App Router without pages/: the `ssr` environment only renders client
 *     components and is skipped entirely.
 *   - Any server environment: `"use client"` modules are skipped (hybrid
 *     App + Pages builds keep `ssr`, which also runs the Pages Router).
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createBuilder } from "vite-plus";
import { afterAll, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";

const ROUTE_ASSET = "vinext-route-handler-server-asset";
const CLIENT_COMPONENT_ASSET = "vinext-use-client-component-asset";
const CLIENT_HELPER_ASSET = "vinext-client-only-helper-asset";
const PAGES_API_ASSET = "vinext-pages-api-server-asset";

const tempRoots: string[] = [];

afterAll(async () => {
  await Promise.all(tempRoots.map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(root, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
}

async function readTree(dir: string, extensions: RegExp, excludeDir?: string): Promise<string> {
  const files = await fs.readdir(dir, { recursive: true });
  let contents = "";
  for (const file of files) {
    const full = path.join(dir, file);
    if (excludeDir !== undefined && !path.relative(excludeDir, full).startsWith("..")) continue;
    if (extensions.test(file) && (await fs.stat(full)).isFile()) {
      contents += await fs.readFile(full, "utf8");
    }
  }
  return contents;
}

function inlinedBytes(content: string): string {
  return Buffer.from(content).toString("base64");
}

async function buildFixture(options: { withPagesRouter: boolean }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-server-url-assets-build-"));
  tempRoots.push(root);
  await fs.symlink(
    path.resolve(import.meta.dirname, "../node_modules"),
    path.join(root, "node_modules"),
    process.platform === "win32" ? "junction" : undefined,
  );

  await writeFiles(root, {
    "package.json": JSON.stringify({ name: "server-url-assets-build", type: "module" }),
    "app/layout.tsx": `export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html>
      <body>{children}</body>
    </html>
  );
}
`,
    "app/page.tsx": `import { ClientAsset } from "./client-asset";

export default function Page() {
  return <ClientAsset />;
}
`,
    // A "use client" component: skipped in every server environment.
    "app/client-asset.tsx": `"use client";
import { helperAssetHref } from "./client-helper";

const componentAssetHref = new URL("./client-component.txt", import.meta.url).href;

export function ClientAsset() {
  return <p>{componentAssetHref} {helperAssetHref}</p>;
}
`,
    // No directive, only reachable from the client component, so on the
    // server it only exists in the `ssr` environment.
    "app/client-helper.ts": `export const helperAssetHref = new URL("./client-helper.txt", import.meta.url).href;
`,
    "app/client-component.txt": CLIENT_COMPONENT_ASSET,
    "app/client-helper.txt": CLIENT_HELPER_ASSET,
    "app/api/route-asset/route.ts": `export const runtime = "edge";

export function GET() {
  return fetch(new URL("../../../server-assets/route.txt", import.meta.url));
}
`,
    "server-assets/route.txt": ROUTE_ASSET,
    ...(options.withPagesRouter
      ? {
          "pages/api/pages-asset.ts": `export const config = { runtime: "edge" };

export default function handler() {
  return fetch(new URL("../../server-assets/pages.txt", import.meta.url));
}
`,
          "server-assets/pages.txt": PAGES_API_ASSET,
        }
      : {}),
  });

  const outDir = path.join(root, "dist");
  const rscOutDir = path.join(outDir, "server");
  const ssrOutDir = path.join(outDir, "server", "ssr");
  const clientOutDir = path.join(outDir, "client");
  const builder = await createBuilder({
    root,
    configFile: false,
    plugins: [vinext({ appDir: root, rscOutDir, ssrOutDir, clientOutDir })],
    logLevel: "silent",
  });
  await builder.buildApp();

  const ssrCode = await readTree(ssrOutDir, /\.m?js$/);
  const rscCode = await readTree(rscOutDir, /\.m?js$/, ssrOutDir);
  return {
    ssrCode,
    rscCode,
    allServerCode: rscCode + ssrCode,
    clientFiles: await readTree(clientOutDir, /\.(?:m?js|txt)$/),
  };
}

describe("vinext:server-url-assets environment scoping", () => {
  it("skips the App Router ssr environment and use client modules", async () => {
    const output = await buildFixture({ withPagesRouter: false });

    // Route handlers run in `rsc` and keep their inlined asset.
    expect(output.rscCode).toContain(inlinedBytes(ROUTE_ASSET));
    // Nothing from client code is inlined into any server output.
    expect(output.allServerCode).not.toContain(inlinedBytes(CLIENT_COMPONENT_ASSET));
    expect(output.allServerCode).not.toContain(inlinedBytes(CLIENT_HELPER_ASSET));
    expect(output.ssrCode).not.toContain(inlinedBytes(ROUTE_ASSET));
    // The client build still emits the browser assets.
    expect(output.clientFiles).toContain(CLIENT_COMPONENT_ASSET);
    expect(output.clientFiles).toContain(CLIENT_HELPER_ASSET);
  }, 120_000);

  it("keeps the ssr environment for the Pages Router but still skips use client modules", async () => {
    const output = await buildFixture({ withPagesRouter: true });

    expect(output.rscCode).toContain(inlinedBytes(ROUTE_ASSET));
    // Hybrid builds run Pages Router routes (including edge API routes) in `ssr`.
    expect(output.ssrCode).toContain(inlinedBytes(PAGES_API_ASSET));
    expect(output.allServerCode).not.toContain(inlinedBytes(CLIENT_COMPONENT_ASSET));
    expect(output.clientFiles).toContain(CLIENT_COMPONENT_ASSET);
  }, 120_000);
});
