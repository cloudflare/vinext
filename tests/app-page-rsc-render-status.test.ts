import { describe, expect, it } from "vite-plus/test";
import { createAppPageRscRenderStatusResolver } from "../packages/vinext/src/server/app-page-rsc-render-status.js";
import type { AppPageSsrHandler } from "../packages/vinext/src/server/app-page-stream.js";

function resolveWithDocument(
  handleSsr: AppPageSsrHandler["handleSsr"],
  deadlineAt: number,
  specialError: unknown = null,
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
    loadSsrHandler: async () => ({ handleSsr }),
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
    let cancelled = false;
    const status = await resolveWithDocument(
      () =>
        new Promise((resolve) => {
          resolveShell = resolve;
        }),
      Date.now() + 20,
    );
    expect(status).toEqual({ kind: "page" });

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

  it("stores no render with a special error whose document missed its deadline", async () => {
    const status = await resolveWithDocument(
      () => new Promise(() => {}),
      Date.now() + 20,
      new Error("special"),
    );
    expect(status).toEqual({ kind: "unstorable" });
  });
});
