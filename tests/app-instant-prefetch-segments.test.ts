import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import {
  resolveAppInstantPrefetchSegmentStages,
  wrapAppInstantPrefetchSegment,
} from "../packages/vinext/src/server/app-instant-prefetch-segments.js";
import {
  createInstantPrefetchShellState,
  runWithInstantPrefetchShellState,
  suspendStaticInstantPrefetchRequestData,
} from "../packages/vinext/src/shims/instant-prefetch-shell.js";

describe("app instant prefetch segment stages", () => {
  // Ported from Next.js:
  // test/e2e/app-dir/segment-cache/prefetch-layout-sharing/prefetch-layout-sharing.test.ts
  // https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/segment-cache/prefetch-layout-sharing/prefetch-layout-sharing.test.ts
  it("starts a new static subtree below a retained runtime layout", () => {
    const runtime = { unstable_instant: { prefetch: "runtime" } };
    const staticallyConfigured = { unstable_instant: { prefetch: "static" } };

    expect(
      resolveAppInstantPrefetchSegmentStages({
        layouts: [runtime],
        page: {},
      }),
    ).toEqual({ layouts: ["runtime"], page: "runtime" });
    expect(
      resolveAppInstantPrefetchSegmentStages({
        layouts: [runtime],
        page: staticallyConfigured,
        retainedLayouts: new Set([0]),
      }),
    ).toEqual({ layouts: ["static"], page: "static" });
  });

  it("keeps a default-static sub-layout outside an explicitly runtime page", () => {
    const stages = resolveAppInstantPrefetchSegmentStages({
      layouts: [{ unstable_instant: { prefetch: "runtime" } }, {}],
      page: { unstable_instant: { prefetch: "runtime" } },
      retainedLayouts: new Set([0]),
    });

    expect(stages).toEqual({ layouts: ["static", "static"], page: "runtime" });
  });

  it("applies the owning segment stage to nested server components", () => {
    function RequestDataProbe() {
      const suspended = suspendStaticInstantPrefetchRequestData("cookies()") !== null;
      return createElement("span", null, suspended ? "static" : "runtime");
    }
    function Segment() {
      return createElement("div", null, createElement(RequestDataProbe));
    }

    const runtimeShell = createInstantPrefetchShellState("/test", "runtime");
    const staticHtml = runWithInstantPrefetchShellState(runtimeShell, () =>
      renderToStaticMarkup(wrapAppInstantPrefetchSegment(createElement(Segment), "static")),
    );
    expect(staticHtml).toBe("<div><span>static</span></div>");

    const staticShell = createInstantPrefetchShellState("/test", "static");
    const runtimeHtml = runWithInstantPrefetchShellState(staticShell, () =>
      renderToStaticMarkup(wrapAppInstantPrefetchSegment(createElement(Segment), "runtime")),
    );
    expect(runtimeHtml).toBe("<div><span>runtime</span></div>");
  });
});
