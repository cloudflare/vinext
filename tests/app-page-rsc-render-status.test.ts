import { describe, expect, it } from "vite-plus/test";
import { createAppPageRscRenderStatusResolver } from "../packages/vinext/src/server/app-page-rsc-render-status.js";
import type { AppPageSsrHandler } from "../packages/vinext/src/server/app-page-stream.js";

function resolveWithDocument(
  handleSsr: AppPageSsrHandler["handleSsr"],
  deadlineAt: number,
  specialError: unknown = null,
  loadSsrHandler: () => Promise<AppPageSsrHandler> = async () => ({ handleSsr }),
) {
  return createAppPageRscRenderStatusResolver({
    capturedRscData: Promise.resolve(new ArrayBuffer(0)),
    document: {
      deadlineAt,
      getFontData: () => ({ links: [], preloads: [], styles: [] }),
      getInitialNavigationCacheMetadata: () => ({}) as never,
      mirrorNextFlight: () => false,
      onSsrError: () => undefined,
    },
    getCapturedSpecialError: () => specialError,
    getCapturedSpecialErrors: () => [],
    isForceStatic: false,
    loadSsrHandler,
    navigationContext: null,
    routePattern: "/page",
  })();
}

describe("createAppPageRscRenderStatusResolver document deadline", () => {
  it("renders the document before its deadline", async () => {
    const status = await resolveWithDocument(
      async () => new Response("<html>page</html>").body!,
      Date.now() + 60_000,
    );
    expect(status).toEqual({ kind: "page", document: { html: "<html>page</html>" } });
  });

  it("gives up a document that is still streaming at its deadline", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("<html>"));
      },
      cancel() {
        cancelled = true;
      },
    });
    const status = await resolveWithDocument(async () => stream, Date.now() + 20);
    expect(status).toEqual({ kind: "page" });
    expect(cancelled).toBe(true);
  });

  it("gives up a shell that hasn't rendered at its deadline", async () => {
    let resolveShell!: (stream: ReadableStream<Uint8Array>) => void;
    let signal: AbortSignal | undefined;
    let cancelled = false;
    const status = await resolveWithDocument(
      (_rscStream, _navigationContext, _fontData, options) => {
        signal = options?.signal;
        return new Promise((resolve) => {
          resolveShell = resolve;
        });
      },
      Date.now() + 20,
    );
    expect(status).toEqual({ kind: "page" });
    // The deadline aborts the render itself.
    expect(signal?.aborted).toBe(true);

    // A shell that renders after the deadline is discarded.
    resolveShell(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cancelled).toBe(true);
  });

  it("gives up a document at a deadline that has already passed", async () => {
    let rendered = false;
    const status = await resolveWithDocument(async () => {
      rendered = true;
      return new Response("<html>page</html>").body!;
    }, Date.now() - 1);
    expect(status).toEqual({ kind: "page" });
    expect(rendered).toBe(false);
  });

  it("gives up a document whose SSR handler hasn't loaded at its deadline", async () => {
    const status = await resolveWithDocument(
      async () => new Response("<html>page</html>").body!,
      Date.now() + 20,
      null,
      () => new Promise(() => {}),
    );
    expect(status).toEqual({ kind: "page" });
  });

  it("stores no render with a special error whose document missed its deadline", async () => {
    const status = await resolveWithDocument(
      () => new Promise(() => {}),
      Date.now() + 20,
      new Error("special"),
    );
    expect(status).toEqual({ kind: "unstorable" });
  });
});

// A special error that a Suspense boundary caught sets a static render's
// status, as in Next.js. The RSC miss stores its payload alone, as for one
// that rejects the shell.
// Ported from Next.js: test/e2e/prerendered-http-status-codes/index.test.ts
// https://github.com/vercel/next.js/blob/v16.4.6/test/e2e/prerendered-http-status-codes/index.test.ts
describe("createAppPageRscRenderStatusResolver special error a Suspense boundary caught", () => {
  const notFoundError = { digest: "NEXT_HTTP_ERROR_FALLBACK;404" };
  const redirectError = { digest: "NEXT_REDIRECT;replace;/target;307;" };

  function documentReportingAfterShell(error: unknown): AppPageSsrHandler["handleSsr"] {
    return async (_rscStream, _navigationContext, _fontData, options) =>
      new ReadableStream<Uint8Array>({
        pull(controller) {
          options?.onSsrError?.(error);
          controller.enqueue(new TextEncoder().encode("<html>fallback</html>"));
          controller.close();
        },
      });
  }

  it("resolves the status of a render whose document it renders to store", async () => {
    const status = await resolveWithDocument(
      documentReportingAfterShell(notFoundError),
      Date.now() + 60_000,
      notFoundError,
    );
    expect(status).toEqual({ kind: "special-error", status: 404 });
  });

  it("renders the whole document of a render that threw a special error", async () => {
    const status = await createAppPageRscRenderStatusResolver({
      basePath: "/docs",
      capturedRscData: Promise.resolve(new ArrayBuffer(0)),
      getCapturedSpecialError: () => redirectError,
      getCapturedSpecialErrors: () => [],
      isForceStatic: false,
      loadSsrHandler: async () => ({ handleSsr: documentReportingAfterShell(redirectError) }),
      navigationContext: null,
      routePattern: "/page",
    })();
    expect(status).toEqual({
      kind: "special-error",
      status: 307,
      headers: { location: "/docs/target" },
    });
  });
});

// As in Next.js's static generation, an HTTP error the document reported
// before the one that rejected the shell can win the status.
// Ported from Next.js: test/e2e/prerendered-http-status-codes/index.test.ts
// https://github.com/vercel/next.js/blob/v16.4.6/test/e2e/prerendered-http-status-codes/index.test.ts
describe("createAppPageRscRenderStatusResolver special error that rejects the shell", () => {
  const notFoundError = { digest: "NEXT_HTTP_ERROR_FALLBACK;404" };
  const unauthorizedError = { digest: "NEXT_HTTP_ERROR_FALLBACK;401" };
  const redirectError = { digest: "NEXT_REDIRECT;replace;/target;307;" };

  function shellRejectingAfter(
    caught: unknown,
    shellError: unknown,
  ): AppPageSsrHandler["handleSsr"] {
    return async (_rscStream, _navigationContext, _fontData, options) => {
      options?.onSsrError?.(caught);
      options?.onSsrError?.(shellError);
      throw shellError;
    };
  }

  it.each([
    { caught: notFoundError, shellError: unauthorizedError, status: 404, headers: undefined },
    {
      caught: redirectError,
      shellError: notFoundError,
      status: 307,
      headers: { location: "/docs/target" },
    },
  ])(
    "resolves the status of the error that wins, $caught.digest before $shellError.digest",
    async ({ caught, shellError, status, headers }) => {
      const result = await createAppPageRscRenderStatusResolver({
        basePath: "/docs",
        capturedRscData: Promise.resolve(new ArrayBuffer(0)),
        getCapturedSpecialError: () => caught,
        getCapturedSpecialErrors: () => [],
        isForceStatic: false,
        loadSsrHandler: async () => ({ handleSsr: shellRejectingAfter(caught, shellError) }),
        navigationContext: null,
        routePattern: "/page",
      })();
      expect(result).toEqual({ kind: "special-error", status, ...(headers ? { headers } : {}) });
    },
  );
});
