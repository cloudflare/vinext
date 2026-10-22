import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { CompatibilityLineChart } from "../apps/web/app/compatibility/compatibility-line-chart";

describe("compatibility trend chart", () => {
  it("plots 50% at the baseline and keeps lower rates inside the chart", () => {
    const counts = {
      total: 10,
      passed: 10,
      failed: 0,
      skipped: 0,
      supportedPassed: 4,
      supportedFailed: 6,
    };
    const markup = renderToStaticMarkup(
      createElement(CompatibilityLineChart, {
        points: [
          {
            createdAt: Date.UTC(2026, 0, 1),
            reconstructed: false,
            byRouter: { all: counts, app: counts, pages: counts, both: counts, unknown: counts },
          },
        ],
      }),
    );

    expect(markup).toContain(">50%</text>");
    expect(markup).toContain(">100%</text>");
    expect(markup).not.toContain(">0%</text>");
    expect(markup).toContain('d="M 412 16"');
    expect(markup).toContain('d="M 412 252"');
  });
});
