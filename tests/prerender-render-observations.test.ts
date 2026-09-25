import { describe, expect, it } from "vite-plus/test";
import {
  appendPrerenderRenderObservations,
  extractPrerenderRenderObservations,
} from "../packages/vinext/src/server/prerender-render-observations.js";
import { queryInvariantPrerenderObservations } from "./render-observation-test-helpers.js";

const HTML = "<!DOCTYPE html><html><body><p>page</p></body></html>";
const MARKER_PREFIX = "<!--vinext-prerender-render-observations:";

function withMarker(html: string, payload: string): string {
  return `${html}${MARKER_PREFIX}${payload}-->`;
}

async function appendTo(
  html: string,
  observations: Parameters<typeof appendPrerenderRenderObservations>[1],
): Promise<string> {
  return new Response(
    appendPrerenderRenderObservations(new Response(html).body!, observations),
  ).text();
}

describe("prerender render observations channel", () => {
  it("round-trips the observations and restores the exact document", async () => {
    const renderObservations = queryInvariantPrerenderObservations();

    const body = await appendTo(HTML, Promise.resolve(renderObservations));

    expect(body.startsWith(HTML)).toBe(true);
    expect(extractPrerenderRenderObservations(body)).toEqual({ html: HTML, renderObservations });
  });

  it("appends nothing without observations", async () => {
    await expect(appendTo(HTML, Promise.resolve(null))).resolves.toBe(HTML);
  });

  it("leaves a body without the marker untouched", () => {
    expect(extractPrerenderRenderObservations(HTML)).toEqual({
      html: HTML,
      renderObservations: null,
    });
    const userComment = `${HTML}<!-- user comment -->`;
    expect(extractPrerenderRenderObservations(userComment)).toEqual({
      html: userComment,
      renderObservations: null,
    });
  });

  it("only reads a marker at the very end of the body", () => {
    const encoded = encodeURIComponent(JSON.stringify(queryInvariantPrerenderObservations()));
    const notTrailing = `${withMarker(HTML, encoded)}<p>after</p>`;
    expect(extractPrerenderRenderObservations(notTrailing)).toEqual({
      html: notTrailing,
      renderObservations: null,
    });
    // A payload that isn't encodeURIComponent output isn't the marker.
    const spansMarkup = withMarker(HTML, "x<p>y</p>");
    expect(extractPrerenderRenderObservations(spansMarkup)).toEqual({
      html: spansMarkup,
      renderObservations: null,
    });
  });

  it("strips a malformed marker and yields no observations", () => {
    const malformed = [
      "not-json",
      "%E0%A4%A",
      encodeURIComponent(JSON.stringify(null)),
      encodeURIComponent(JSON.stringify({ html: {} })),
      encodeURIComponent(
        JSON.stringify({ html: { completeness: "complete", requestApis: [null] }, rsc: {} }),
      ),
    ];
    for (const payload of malformed) {
      expect(extractPrerenderRenderObservations(withMarker(HTML, payload))).toEqual({
        html: HTML,
        renderObservations: null,
      });
    }
  });
});
