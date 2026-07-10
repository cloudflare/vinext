import fs from "node:fs/promises";
import { createServer, request as sendHttpRequest, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "@playwright/test";

type CapturedRequest = {
  revalidateHeader: string | undefined;
  revalidateOnlyGeneratedHeader: string | undefined;
  url: string;
};

let appPort = 0;
let appServer: Server;
let fixtureRoot = "";
let outsidePort = 0;
let outsideServer: Server;
const capturedRequests: CapturedRequest[] = [];

async function closeServer(server: Server): Promise<void> {
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeIdleConnections();
  server.closeAllConnections();
  await closed;
}

async function writeFile(filePath: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents);
}

async function createHybridFixture(externalOrigin: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-hybrid-revalidate-"));
  await fs.symlink(
    path.resolve(process.cwd(), "tests/fixtures/app-basic/node_modules"),
    path.join(root, "node_modules"),
    "junction",
  );
  await writeFile(path.join(root, "package.json"), '{"type":"module"}\n');
  await writeFile(
    path.join(root, "app/layout.tsx"),
    `export default function Layout({ children }: { children: React.ReactNode }) {
  return <html><body>{children}</body></html>;
}
`,
  );
  await writeFile(
    path.join(root, "app/page.tsx"),
    `export default function AppPage() { return <main>App page</main>; }\n`,
  );
  await writeFile(
    path.join(root, "pages/api/revalidate.ts"),
    `import type { NextApiRequest, NextApiResponse } from "next";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<{ revalidated: boolean }>,
) {
  const target = typeof req.query.target === "string" ? req.query.target : "/revalidate-target";
  try {
    await res.revalidate(target, { unstable_onlyGenerated: true });
    res.json({ revalidated: true });
  } catch {
    res.json({ revalidated: false });
  }
}
`,
  );
  const pageSource = `export async function getStaticProps() {
  return { props: { renderedAt: Date.now() }, revalidate: 3600 };
}

export default function Page({ renderedAt }: { renderedAt: number }) {
  return <main>{renderedAt}</main>;
}
`;
  await writeFile(path.join(root, "pages/revalidate-target.tsx"), pageSource);
  await writeFile(path.join(root, "pages/middleware-target.tsx"), pageSource);
  await writeFile(
    path.join(root, "middleware.ts"),
    `import { NextResponse, type NextRequest } from "next/server";

export function middleware(request: NextRequest) {
  if (request.nextUrl.pathname === "/middleware-target") {
    return NextResponse.rewrite(${JSON.stringify(`${externalOrigin}/middleware-capture`)});
  }
  return NextResponse.next();
}
`,
  );
  await writeFile(
    path.join(root, "next.config.mjs"),
    `export default {
  async rewrites() {
    return [
      {
        source: "/config-target",
        destination: ${JSON.stringify(`${externalOrigin}/config-capture`)},
      },
    ];
  },
};
`,
  );
  const vinextSource = pathToFileURL(
    path.resolve(process.cwd(), "packages/vinext/src/index.ts"),
  ).href;
  await writeFile(
    path.join(root, "vite.config.ts"),
    `import { defineConfig } from "vite";
import vinext from ${JSON.stringify(vinextSource)};

export default defineConfig({ plugins: [vinext({ appDir: import.meta.dirname })] });
`,
  );
  return root;
}

async function requestRevalidate(
  target: string,
  host = `127.0.0.1:${appPort}`,
): Promise<{ revalidated: boolean }> {
  return new Promise((resolve, reject) => {
    const request = sendHttpRequest(
      {
        hostname: "127.0.0.1",
        port: appPort,
        path: `/api/revalidate?target=${encodeURIComponent(target)}`,
        headers: { host },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.on("error", reject);
    request.end();
  });
}

test.describe.configure({ mode: "serial" });
test.setTimeout(120_000);

test.beforeAll(async () => {
  outsideServer = createServer((request, response) => {
    const header = request.headers["x-prerender-revalidate"];
    const onlyGeneratedHeader = request.headers["x-prerender-revalidate-if-generated"];
    capturedRequests.push({
      revalidateHeader: Array.isArray(header) ? header[0] : header,
      revalidateOnlyGeneratedHeader: Array.isArray(onlyGeneratedHeader)
        ? onlyGeneratedHeader[0]
        : onlyGeneratedHeader,
      url: request.url ?? "",
    });
    response.writeHead(200);
    response.end("outside");
  });
  await new Promise<void>((resolve) => outsideServer.listen(0, "127.0.0.1", resolve));
  const address = outsideServer.address();
  if (!address || typeof address === "string") throw new Error("Expected outside TCP server");
  outsidePort = address.port;

  fixtureRoot = await createHybridFixture(`http://127.0.0.1:${outsidePort}`);
  const previousRevalidateSecret = process.env.__VINEXT_SHARED_REVALIDATE_SECRET;
  process.env.__VINEXT_SHARED_REVALIDATE_SECRET = "11".repeat(32);
  try {
    const { createBuilder } = await import("vite");
    const builder = await createBuilder({
      root: fixtureRoot,
      configFile: path.join(fixtureRoot, "vite.config.ts"),
      logLevel: "silent",
    });
    await builder.buildApp();
  } finally {
    if (previousRevalidateSecret === undefined) {
      delete process.env.__VINEXT_SHARED_REVALIDATE_SECRET;
    } else {
      process.env.__VINEXT_SHARED_REVALIDATE_SECRET = previousRevalidateSecret;
    }
  }

  const { startProdServer } = await import(
    pathToFileURL(path.resolve(process.cwd(), "packages/vinext/dist/server/prod-server.js")).href
  );
  const started = await startProdServer({
    host: "127.0.0.1",
    port: 0,
    outDir: path.join(fixtureRoot, "dist"),
    noCompression: true,
  });
  appPort = started.port;
  appServer = started.server;
});

test.beforeEach(() => {
  capturedRequests.length = 0;
});

test.afterAll(async () => {
  if (appServer) await closeServer(appServer);
  if (outsideServer) await closeServer(outsideServer);
  if (fixtureRoot) await fs.rm(fixtureRoot, { recursive: true, force: true });
});

test("hybrid Pages fallback uses the server-owned revalidation origin", async () => {
  const result = await requestRevalidate("/revalidate-target", `127.0.0.1:${outsidePort}`);

  expect(result).toEqual({ revalidated: true });
  expect(capturedRequests).toEqual([]);
});

test("authenticated revalidation bypasses middleware", async () => {
  const result = await requestRevalidate("/middleware-target");

  expect(result).toEqual({ revalidated: true });
  expect(capturedRequests).toEqual([]);
});

test("external config rewrites do not receive revalidation credentials", async () => {
  const result = await requestRevalidate("/config-target");

  expect(result).toEqual({ revalidated: true });
  expect(capturedRequests).toEqual([
    {
      revalidateHeader: undefined,
      revalidateOnlyGeneratedHeader: undefined,
      url: "/config-capture",
    },
  ]);
});
