/**
 * The status and boundary of an App Router render error thrown before the
 * document's shell is sent, per issue #4394.
 *
 * Next.js answers 500 whichever boundary catches such an error (`renderToStream`
 * in app-render.tsx). A layout's own error.tsx wraps only its children, so the
 * error.tsx above a throwing layout catches its error, and global-error.tsx
 * catches the root layout's. An error streamed inside Suspense keeps the 200
 * the shell already sent.
 * https://github.com/vercel/next.js/blob/v16.2.6/packages/next/src/server/app-render/app-render.tsx
 * https://github.com/vercel/next.js/blob/v16.2.6/packages/next/src/server/app-render/create-component-tree.tsx
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createBuilder, preview } from "vite-plus";
import vinext from "../packages/vinext/src/index.js";
import { startFixtureServer, testCacheDir } from "./helpers.js";

const errorBoundary = (id: string) => `"use client";

export default function ErrorBoundary({ error }: { error: Error & { digest?: string } }) {
  return <p id="${id}">${id} caught</p>;
}
`;

const layout = (
  id: string,
) => `export default function Layout({ children }: { children: React.ReactNode }) {
  return <div id="${id}">{children}</div>;
}
`;

const throwingLayout = (message: string) => `import { cookies } from "next/headers";

export default async function ThrowingLayout({ children }: { children: React.ReactNode }) {
  await cookies();
  throw new Error("${message}");
}
`;

const PAGE = `export default function Page() {
  return <p id="page">page rendered</p>;
}
`;

const FILES: Record<string, string> = {
  // The root layout throws when the request asks it to, so one app covers the
  // root-layout case too.
  "app/layout.tsx": `import { headers } from "next/headers";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  if ((await headers()).get("x-throw-root-layout") === "1") {
    throw new Error("root layout failed");
  }
  return (
    <html>
      <body>
        <div id="root-layout">{children}</div>
      </body>
    </html>
  );
}
`,
  "app/error.tsx": errorBoundary("root-error"),
  "app/global-error.tsx": `"use client";

export default function GlobalError() {
  return (
    <html>
      <body>
        <p id="global-error">global-error caught</p>
      </body>
    </html>
  );
}
`,
  "app/page.tsx": PAGE,
  "app/throw-page/page.tsx": `import { cookies } from "next/headers";

export default async function ThrowPage() {
  await cookies();
  throw new Error("page render failed");
}
`,
  "app/nested/error.tsx": errorBoundary("nested-error"),
  "app/nested/throw/page.tsx": `import { cookies } from "next/headers";

export default async function NestedThrowPage() {
  await cookies();
  throw new Error("nested page render failed");
}
`,
  // A layout's own error.tsx sits inside it, so it can't catch the layout.
  "app/badlayout/layout.tsx": throwingLayout("nested layout failed"),
  "app/badlayout/error.tsx": errorBoundary("badlayout-error"),
  "app/badlayout/page.tsx": PAGE,
  // The boundary above a deeper throwing layout renders inside the layouts
  // above it.
  "app/outer/layout.tsx": layout("outer-layout"),
  "app/outer/error.tsx": errorBoundary("outer-error"),
  "app/outer/inner/layout.tsx": throwingLayout("inner layout failed"),
  "app/outer/inner/error.tsx": errorBoundary("inner-error"),
  "app/outer/inner/page.tsx": PAGE,
  "app/streamed/page.tsx": `import { Suspense } from "react";
import { cookies } from "next/headers";

async function StreamedThrow(): Promise<never> {
  await cookies();
  await new Promise((resolve) => setTimeout(resolve, 10));
  throw new Error("streamed render failed");
}

export default function StreamedPage() {
  return (
    <div>
      <p id="streamed-shell">streamed shell</p>
      <Suspense fallback={<p>Loading...</p>}>
        <StreamedThrow />
      </Suspense>
    </div>
  );
}
`,
  "app/missing/page.tsx": `import { notFound } from "next/navigation";

export default function MissingPage() {
  notFound();
}
`,
};

function writeApp(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-render-error-status-"));
  fs.symlinkSync(
    path.resolve(import.meta.dirname, "fixtures/app-basic/node_modules"),
    path.join(root, "node_modules"),
    "junction",
  );
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}\n');
  for (const [file, source] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), source);
  }
  return root;
}

async function startPreview(root: string) {
  const builder = await createBuilder({
    root,
    cacheDir: testCacheDir(root),
    configFile: false,
    plugins: [vinext({ appDir: root })],
    logLevel: "silent",
  });
  await builder.buildApp();
  const server = await preview({
    root,
    cacheDir: testCacheDir(root),
    configFile: false,
    plugins: [vinext({ appDir: root })],
    preview: { port: 0 },
    logLevel: "silent",
  });
  const address = server.httpServer.address();
  if (!address || typeof address !== "object") {
    throw new Error("Preview server did not expose a port");
  }
  return {
    baseUrl: `http://localhost:${address.port}`,
    close: () => new Promise<void>((resolve) => server.httpServer.close(() => resolve())),
  };
}

async function startDev(root: string) {
  const { server, baseUrl } = await startFixtureServer(root);
  return { baseUrl, close: () => server.close() };
}

describe.each([
  { mode: "dev", start: startDev },
  { mode: "production preview", start: startPreview },
])("App Router render error status ($mode)", ({ start }) => {
  let root: string;
  let baseUrl: string;
  let close: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    root = writeApp();
    ({ baseUrl, close } = await start(root));
  }, 120_000);

  afterAll(async () => {
    await close?.();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  async function get(pathname: string, headers?: Record<string, string>) {
    const res = await fetch(`${baseUrl}${pathname}`, { headers });
    return { res, html: await res.text() };
  }

  function expectHtmlError(res: Response) {
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toContain("text/html");
  }

  it("renders the page with 200 when nothing throws", async () => {
    const { res, html } = await get("/");
    expect(res.status).toBe(200);
    expect(html).toContain('id="page"');
  });

  it("renders the root error.tsx with 500 when a page throws", async () => {
    const { res, html } = await get("/throw-page");
    expectHtmlError(res);
    expect(html).toContain('id="root-error"');
    expect(html).toContain('id="root-layout"');
    expect(html).not.toContain('id="global-error"');
  });

  it("renders the nested error.tsx with 500 when a nested page throws", async () => {
    const { res, html } = await get("/nested/throw");
    expectHtmlError(res);
    expect(html).toContain('id="nested-error"');
    expect(html).not.toContain('id="root-error"');
  });

  it("renders the error.tsx above a throwing nested layout with 500", async () => {
    const { res, html } = await get("/badlayout");
    expectHtmlError(res);
    expect(html).toContain('id="root-error"');
    expect(html).toContain('id="root-layout"');
    expect(html).not.toContain('id="badlayout-error"');
    expect(html).not.toContain('id="global-error"');
  });

  it("renders the boundary above a deeper throwing layout inside the layouts above it", async () => {
    const { res, html } = await get("/outer/inner");
    expectHtmlError(res);
    expect(html).toContain('id="outer-error"');
    expect(html).toContain('id="outer-layout"');
    expect(html).toContain('id="root-layout"');
    expect(html).not.toContain('id="inner-error"');
    expect(html).not.toContain('id="root-error"');
  });

  it("renders global-error.tsx with 500 when the root layout throws", async () => {
    const { res, html } = await get("/", { "x-throw-root-layout": "1" });
    expectHtmlError(res);
    expect(html).toContain('id="global-error"');
    expect(html).not.toContain('id="root-error"');
    expect(html).not.toContain('id="root-layout"');
  });

  it("keeps 200 for an error streamed inside Suspense after the shell", async () => {
    const { res, html } = await get("/streamed");
    expect(res.status).toBe(200);
    expect(html).toContain('id="streamed-shell"');
  });

  it("keeps 404 for notFound()", async () => {
    const { res } = await get("/missing");
    expect(res.status).toBe(404);
  });
});
