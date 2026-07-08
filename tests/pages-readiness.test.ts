import { describe, expect, it } from "vite-plus/test";
import { buildPagesReadinessNextData } from "../packages/vinext/src/server/pages-readiness.js";

describe("buildPagesReadinessNextData", () => {
  // Ported from Next.js: test/e2e/auto-export/auto-export.test.ts
  // https://github.com/vercel/next.js/blob/v16.3.0-canary.80/test/e2e/auto-export/auto-export.test.ts
  it("marks automatically exported pages with nextExport", () => {
    expect(
      buildPagesReadinessNextData({
        pageModule: { default: () => null },
        appComponent: null,
        hasRewrites: false,
      }),
    ).toMatchObject({
      autoExport: true,
      nextExport: true,
    });
  });

  it("omits nextExport for data-driven pages", () => {
    expect(
      buildPagesReadinessNextData({
        pageModule: {
          default: () => null,
          getServerSideProps: async () => ({ props: {} }),
        },
        appComponent: null,
        hasRewrites: false,
      }).nextExport,
    ).toBeUndefined();
  });
});
