/**
 * Build-level scoping for `vinext:server-url-assets`.
 *
 * Server code fetches `new URL(<file>, import.meta.url)` assets, so their bytes
 * ship in the server bundle (see tests/server-url-assets.test.ts). Client
 * components only reference browser assets, so their files must not be
 * inlined into server or Worker output:
 *   - App Router without pages/: the `ssr` environment only renders client
 *     components and is skipped entirely.
 *   - `rsc`: `"use client"` modules are client references and are skipped.
 *   - Hybrid App + Pages `ssr`: modules that only App Router client references
 *     reach are skipped, `"use client"` or not. Modules the Pages Router also
 *     imports are kept, including a `"use client"` component shared with
 *     `app/` (the Pages Router runs it on the server) and its imports.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createBuilder } from "vite-plus";
import { afterAll, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";

const ROUTE_ASSET = "vinext-route-handler-server-asset";
const TRIVIA_ROUTE_ASSET = "vinext-trivia-route-handler-server-asset";
const CLIENT_COMPONENT_ASSET = "vinext-use-client-component-asset";
const CLIENT_HELPER_ASSET = "vinext-client-only-helper-asset";
const PAGES_API_ASSET = "vinext-pages-api-server-asset";
const SHARED_HELPER_ASSET = "vinext-shared-helper-server-asset";
const SHARED_COMPONENT_ASSET = "vinext-shared-use-client-component-asset";
const SHARED_COMPONENT_HELPER_ASSET = "vinext-shared-use-client-helper-asset";

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
import { SharedWidget } from "../components/shared-widget";

export default function Page() {
  return (
    <>
      <ClientAsset />
      <SharedWidget text="app" />
    </>
  );
}
`,
    // A "use client" component that only the App Router uses: client code in
    // every server environment.
    "app/client-asset.tsx": `"use client";
import { helperAssetHref } from "./client-helper";
import { sharedAssetUrl } from "../lib/shared-helper";

const componentAssetHref = new URL("./client-component.txt", import.meta.url).href;

export function ClientAsset() {
  return <p>{componentAssetHref} {helperAssetHref} {sharedAssetUrl().pathname}</p>;
}
`,
    // No directive, only reachable from the client component, so on the
    // server it only exists in the `ssr` environment.
    "app/client-helper.ts": `export const helperAssetHref = new URL("./client-helper.txt", import.meta.url).href;
`,
    // Imported by the client component and, in hybrid builds, by a Pages
    // API route, where the reference must still be served on the server.
    "lib/shared-helper.ts": `export function sharedAssetUrl() {
  return new URL("./shared-helper.txt", import.meta.url);
}
`,
    "lib/shared-helper.txt": SHARED_HELPER_ASSET,
    // A "use client" component used by the App Router and, in hybrid builds,
    // by a Pages page whose getServerSideProps fetches its assets. Its helper
    // is only reachable through the component.
    "components/shared-widget.tsx": `"use client";
import { sharedWidgetHelperUrl } from "./shared-widget-helper";

export async function loadSharedWidgetText() {
  const own = await fetch(new URL("./shared-widget.txt", import.meta.url));
  const helper = await fetch(sharedWidgetHelperUrl());
  return (await own.text()) + (await helper.text());
}

export function SharedWidget({ text }: { text: string }) {
  return <p>{text}</p>;
}
`,
    "components/shared-widget-helper.ts": `export function sharedWidgetHelperUrl() {
  return new URL("./shared-widget-helper.txt", import.meta.url);
}
`,
    "components/shared-widget.txt": SHARED_COMPONENT_ASSET,
    "components/shared-widget-helper.txt": SHARED_COMPONENT_HELPER_ASSET,
    "app/client-component.txt": CLIENT_COMPONENT_ASSET,
    "app/client-helper.txt": CLIENT_HELPER_ASSET,
    "app/api/route-asset/route.ts": `export const runtime = "edge";

export function GET() {
  return fetch(new URL("../../../server-assets/route.txt", import.meta.url));
}
`,
    "server-assets/route.txt": ROUTE_ASSET,
    // Comments, newlines and `)` between the tokens must not hide the
    // reference from the transform's native code filter. Earlier transforms
    // reprint `.ts`/`.js` modules without these comments, but an `.mjs` module
    // reaches the filter with its line comment (and its `)`) intact.
    "app/api/trivia-asset/route.js": `import { triviaAssetUrl } from "./trivia-asset.mjs";

export function GET() {
  return fetch(triviaAssetUrl());
}
`,
    "app/api/trivia-asset/trivia-asset.mjs": `export function triviaAssetUrl() {
  return new URL(
    // bundled with the Worker :)
    "../../../server-assets/trivia.txt" /* ) */,
    import /* comment */ .meta
      .url,
  );
}
`,
    "server-assets/trivia.txt": TRIVIA_ROUTE_ASSET,
    ...(options.withPagesRouter
      ? {
          "pages/api/pages-asset.ts": `import { sharedAssetUrl } from "../../lib/shared-helper";

export const config = { runtime: "edge" };

export default function handler(request: Request) {
  if (new URL(request.url).searchParams.has("shared")) return fetch(sharedAssetUrl());
  return fetch(new URL("../../server-assets/pages.txt", import.meta.url));
}
`,
          "server-assets/pages.txt": PAGES_API_ASSET,
          "pages/widget.tsx": `import { loadSharedWidgetText, SharedWidget } from "../components/shared-widget";

export async function getServerSideProps() {
  return { props: { text: await loadSharedWidgetText() } };
}

export default function WidgetPage({ text }: { text: string }) {
  return <SharedWidget text={text} />;
}
`,
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
  it("skips the App Router ssr environment and client references", async () => {
    const output = await buildFixture({ withPagesRouter: false });

    // Route handlers run in `rsc` and keep their inlined asset.
    expect(output.rscCode).toContain(inlinedBytes(ROUTE_ASSET));
    expect(output.rscCode).toContain(inlinedBytes(TRIVIA_ROUTE_ASSET));
    // Nothing from client code is inlined into any server output.
    expect(output.allServerCode).not.toContain(inlinedBytes(CLIENT_COMPONENT_ASSET));
    expect(output.allServerCode).not.toContain(inlinedBytes(CLIENT_HELPER_ASSET));
    expect(output.allServerCode).not.toContain(inlinedBytes(SHARED_HELPER_ASSET));
    expect(output.allServerCode).not.toContain(inlinedBytes(SHARED_COMPONENT_ASSET));
    expect(output.allServerCode).not.toContain(inlinedBytes(SHARED_COMPONENT_HELPER_ASSET));
    expect(output.ssrCode).not.toContain(inlinedBytes(ROUTE_ASSET));
    // The client build still emits the browser assets.
    expect(output.clientFiles).toContain(CLIENT_COMPONENT_ASSET);
    expect(output.clientFiles).toContain(CLIENT_HELPER_ASSET);
  }, 120_000);

  it("keeps Pages Router code in ssr but skips App Router-only client code", async () => {
    const output = await buildFixture({ withPagesRouter: true });

    expect(output.rscCode).toContain(inlinedBytes(ROUTE_ASSET));
    // Hybrid builds run Pages Router routes (including edge API routes) in `ssr`.
    expect(output.ssrCode).toContain(inlinedBytes(PAGES_API_ASSET));
    expect(output.allServerCode).not.toContain(inlinedBytes(CLIENT_COMPONENT_ASSET));
    // A client component's own imports are client code as well, even though
    // they do not repeat the directive.
    expect(output.allServerCode).not.toContain(inlinedBytes(CLIENT_HELPER_ASSET));
    // A helper the Pages Router also imports is still served on the server.
    expect(output.ssrCode).toContain(inlinedBytes(SHARED_HELPER_ASSET));
    // So is a helper reachable only through a "use client" component that the
    // Pages Router also imports, and that component itself: the Pages Router
    // runs both on the server.
    expect(output.ssrCode).toContain(inlinedBytes(SHARED_COMPONENT_HELPER_ASSET));
    expect(output.ssrCode).toContain(inlinedBytes(SHARED_COMPONENT_ASSET));
    expect(output.clientFiles).toContain(CLIENT_COMPONENT_ASSET);
    expect(output.clientFiles).toContain(CLIENT_HELPER_ASSET);
  }, 120_000);
});
