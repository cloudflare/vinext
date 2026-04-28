import { describe, expect, it } from "vite-plus/test";
import type { ModuleRunner } from "vite/module-runner";
import { runMiddleware } from "../packages/vinext/src/server/middleware.js";
import { NextRequest, NextResponse } from "../packages/vinext/src/shims/server.js";

function createRunner(moduleExports: Record<string, unknown>): ModuleRunner {
  return {
    async import() {
      return moduleExports;
    },
  } as unknown as ModuleRunner;
}

describe("middleware runner", () => {
  it("preserves cross-origin rewrite URLs for proxying", async () => {
    const result = await runMiddleware(
      createRunner({
        middleware() {
          return NextResponse.rewrite("https://example.com/external?from=middleware");
        },
      }),
      "/fixture/middleware.ts",
      new Request("http://localhost/_next/static/chunks/pages/_app-non-existent.js"),
    );

    expect(result).toMatchObject({
      continue: true,
      rewriteUrl: "https://example.com/external?from=middleware",
    });
  });

  it("normalizes same-origin rewrite URLs to path and search", async () => {
    const result = await runMiddleware(
      createRunner({
        middleware(request: NextRequest) {
          return NextResponse.rewrite(new URL("/target?from=middleware", request.url));
        },
      }),
      "/fixture/middleware.ts",
      new Request("http://localhost/original?keep=1"),
    );

    expect(result).toMatchObject({
      continue: true,
      rewriteUrl: "/target?from=middleware",
    });
  });

  it("exposes an empty NextURL basePath for unprefixed middleware requests", async () => {
    // Ported from Next.js: test/e2e/middleware-base-path/test/index.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/middleware-base-path/test/index.test.ts
    let seenBasePath: string | undefined;
    const result = await runMiddleware(
      createRunner({
        middleware(request: NextRequest) {
          seenBasePath = request.nextUrl.basePath;
          request.nextUrl.basePath = "/root";
          return NextResponse.redirect(request.nextUrl as unknown as URL);
        },
      }),
      "/fixture/middleware.ts",
      new Request("http://localhost/redirect-with-basepath"),
      undefined,
      "",
    );

    expect(seenBasePath).toBe("");
    expect(result).toMatchObject({
      continue: false,
      redirectUrl: "http://localhost/root/redirect-with-basepath",
      redirectStatus: 307,
    });
  });

  it("preserves NextURL basePath for stripped middleware requests that originally had it", async () => {
    let seenBasePath: string | undefined;
    const result = await runMiddleware(
      createRunner({
        middleware(request: NextRequest) {
          seenBasePath = request.nextUrl.basePath;
          request.nextUrl.pathname = "/about";
          return NextResponse.rewrite(request.nextUrl as unknown as URL);
        },
      }),
      "/fixture/middleware.ts",
      new Request("http://localhost/redirect-with-basepath"),
      undefined,
      "/root",
    );

    expect(seenBasePath).toBe("/root");
    expect(result).toMatchObject({
      continue: true,
      rewriteUrl: "/about",
    });
  });
});
