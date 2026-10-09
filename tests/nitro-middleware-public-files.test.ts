import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createBuilder, type Plugin } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";
import {
  collectMiddlewareCoveredPublicFiles,
  generateNitroMiddlewarePublicFilesPlugin,
} from "../packages/vinext/src/build/nitro-middleware-public-files.js";

const NITRO_NODE_MODULES = path.resolve(
  import.meta.dirname,
  "../examples/app-router-nitro/node_modules",
);

const SVG = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';

async function getAvailablePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function waitForServer(url: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await fetch(url);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function stopServer(server: ChildProcess | undefined): Promise<void> {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => server.once("exit", () => resolve()));
  server.kill("SIGTERM");
  await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 3_000))]);
}

const MIDDLEWARE = `import { NextResponse } from "next/server";
export const config = {
  matcher: [
    "/file.svg",
    "/vercel copy.svg",
    "/another/file.svg",
    "/pass/:path*",
    "/hello",
  ],
};
export default function middleware(request) {
  if (request.nextUrl.pathname.startsWith("/pass/")) {
    const response = NextResponse.next();
    response.headers.set("x-nitro-middleware", request.nextUrl.pathname);
    return response;
  }
  return NextResponse.json({ middleware: true });
}
`;

type Router = "app" | "pages";

async function buildAndServe(router: Router) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `vinext-nitro-mw-public-${router}-`));
  await Promise.all([
    fs.mkdir(path.join(root, router === "app" ? "app/hello" : "pages"), { recursive: true }),
    fs.mkdir(path.join(root, "public/another"), { recursive: true }),
    fs.mkdir(path.join(root, "public/pass"), { recursive: true }),
    fs.symlink(NITRO_NODE_MODULES, path.join(root, "node_modules"), "junction"),
  ]);
  const pages: Array<[string, string]> =
    router === "app"
      ? [
          [
            "app/layout.tsx",
            "export default function Root({ children }) { return <html><body>{children}</body></html>; }\n",
          ],
          ["app/page.tsx", "export default function Page() { return <p>home</p>; }\n"],
          ["app/hello/page.tsx", "export default function Page() { return <p>hello</p>; }\n"],
        ]
      : [
          ["pages/index.tsx", "export default function Page() { return <p>home</p>; }\n"],
          ["pages/hello.tsx", "export default function Page() { return <p>hello</p>; }\n"],
        ];
  await Promise.all([
    fs.writeFile(path.join(root, "package.json"), JSON.stringify({ type: "module" })),
    fs.writeFile(path.join(root, "middleware.ts"), MIDDLEWARE),
    fs.writeFile(
      path.join(root, "next.config.mjs"),
      `export default {
  async rewrites() {
    return { beforeFiles: [{ source: "/alias/:path*", destination: "/:path*" }] };
  },
};
`,
    ),
    fs.writeFile(path.join(root, "public/file.svg"), SVG),
    fs.writeFile(path.join(root, "public/vercel copy.svg"), SVG),
    fs.writeFile(path.join(root, "public/another/file.svg"), SVG),
    fs.writeFile(path.join(root, "public/pass/file.txt"), "passed through"),
    fs.writeFile(path.join(root, "public/open.txt"), "not covered"),
    ...pages.map(([file, source]) => fs.writeFile(path.join(root, file), source)),
  ]);

  const nitroModule = (await import(
    pathToFileURL(path.join(NITRO_NODE_MODULES, "nitro/dist/vite.mjs")).href
  )) as { nitro(config?: Record<string, unknown>): Plugin[] };
  const builder = await createBuilder({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [
      vinext(router === "app" ? { appDir: root } : {}),
      nitroModule.nitro({ buildDir: path.join(root, ".nitro") }),
    ],
  });
  await builder.buildApp();

  const port = await getAvailablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, [path.join(root, ".output/server/index.mjs")], {
    cwd: root,
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port) },
    stdio: "ignore",
  });
  await waitForServer(baseUrl);
  return { root, server, baseUrl };
}

// Ported from Next.js: test/e2e/middleware-static-files/index.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/middleware-static-files/index.test.ts
describe.each(["app", "pages"] as const)(
  "%s router on Nitro: middleware runs before public files its matcher covers",
  (router) => {
    let root = "";
    let server: ChildProcess | undefined;
    let baseUrl = "";

    beforeAll(async () => {
      ({ root, server, baseUrl } = await buildAndServe(router));
    }, 180_000);

    afterAll(async () => {
      await stopServer(server);
      if (root) await fs.rm(root, { recursive: true, force: true });
    });

    it.each(["/file.svg", "/vercel copy.svg", "/vercel%20copy.svg", "/another/file.svg"])(
      "runs middleware for %s",
      async (testPath) => {
        const response = await fetch(`${baseUrl}${testPath}`, { redirect: "manual" });
        expect(await response.json()).toEqual({ middleware: true });
      },
    );

    it("runs middleware for a page its matcher covers", async () => {
      const response = await fetch(`${baseUrl}/hello`, { redirect: "manual" });
      expect(await response.json()).toEqual({ middleware: true });
    });

    it("does not serve a covered file past middleware through a trailing slash", async () => {
      const response = await fetch(`${baseUrl}/file.svg/`, { redirect: "manual" });
      expect(await response.text()).not.toBe(SVG);
    });

    it("serves the file once middleware lets the request continue", async () => {
      const response = await fetch(`${baseUrl}/pass/file.txt`);
      expect(response.status).toBe(200);
      expect(response.headers.get("x-nitro-middleware")).toBe("/pass/file.txt");
      expect(await response.text()).toBe("passed through");
    });

    // Next.js runs middleware once, for the request pathname; a rewrite
    // destination the matcher covers is served without running it again.
    it("serves a covered file reached through a rewrite", async () => {
      const response = await fetch(`${baseUrl}/alias/file.svg`);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(SVG);
    });

    it("keeps serving a file the matcher does not cover from Nitro's static handler", async () => {
      const response = await fetch(`${baseUrl}/open.txt`);
      expect(response.status).toBe(200);
      expect(response.headers.get("x-nitro-middleware")).toBeNull();
      expect(await response.text()).toBe("not covered");
    });
  },
);

describe("collectMiddlewareCoveredPublicFiles", () => {
  const roots: string[] = [];

  afterAll(async () => {
    for (const root of roots) await fs.rm(root, { recursive: true, force: true });
  });

  async function publicRoot(): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-nitro-mw-public-scan-"));
    roots.push(root);
    await fs.mkdir(path.join(root, "public/docs"), { recursive: true });
    await Promise.all(
      ["a.txt", "b copy.txt", "docs/index.html", "docs/c.txt"].map((file) =>
        fs.writeFile(path.join(root, "public", file), file),
      ),
    );
    return root;
  }

  it("lists the decoded paths of the files the matcher covers", async () => {
    const root = await publicRoot();
    expect(
      collectMiddlewareCoveredPublicFiles({
        root,
        publicDir: "public",
        matcher: ["/b copy.txt", "/docs/:path*"],
      }),
    ).toEqual(["/b copy.txt", "/docs/c.txt", "/docs/index.html"]);
  });

  it("covers a directory index.html the static handler would serve at the matched directory", async () => {
    const root = await publicRoot();
    expect(
      collectMiddlewareCoveredPublicFiles({ root, publicDir: "public", matcher: ["/docs"] }),
    ).toEqual(["/docs/index.html"]);
  });

  it("covers every file when the matcher cannot be read statically", async () => {
    const root = await publicRoot();
    expect(
      collectMiddlewareCoveredPublicFiles({ root, publicDir: "public", matcher: undefined }),
    ).toEqual(["/a.txt", "/b copy.txt", "/docs/c.txt", "/docs/index.html"]);
  });

  it("ignores has/missing conditions, which depend on the request", async () => {
    const root = await publicRoot();
    expect(
      collectMiddlewareCoveredPublicFiles({
        root,
        publicDir: "public",
        matcher: [{ source: "/a.txt", has: [{ type: "header", key: "x-never" }] }],
      }),
    ).toEqual(["/a.txt"]);
  });

  it("covers nothing without a public directory", async () => {
    const root = await publicRoot();
    expect(
      collectMiddlewareCoveredPublicFiles({ root, publicDir: false, matcher: undefined }),
    ).toEqual([]);
  });

  it("emits a no-op Nitro plugin when no file is covered", () => {
    expect(generateNitroMiddlewarePublicFilesPlugin([])).toBe("export default function () {}\n");
    expect(generateNitroMiddlewarePublicFilesPlugin(["/a.txt"])).toContain(
      'fetchViteEnv("ssr", request)',
    );
  });
});
