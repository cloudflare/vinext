import { describe, expect, it } from "vite-plus/test";
import {
  ALL_RENDER_REQUEST_API_KINDS,
  buildRenderObservation,
  buildRenderRequestApiObservations,
  type CacheProofOutputScope,
  type RenderRequestApiKind,
} from "../packages/vinext/src/server/cache-proof.js";
import {
  appendPrerenderRenderObservations,
  createPrerenderObservationNonce,
  extractPrerenderRenderObservations,
  isPrerenderRenderObservations,
  type PrerenderRenderObservations,
} from "../packages/vinext/src/server/prerender-render-observations.js";
import {
  malformedPrerenderObservations,
  queryInvariantPrerenderObservations,
} from "./render-observation-test-helpers.js";

const HTML = "<!DOCTYPE html><html><body><p>page</p></body></html>";
const MARKER_PREFIX = "<!--vinext-prerender-render-observations:";
const NONCE = "0f8e6f7c-2b1a-4c3d-9e8f-7a6b5c4d3e2f";

function withMarker(html: string, nonce: string, payload: string): string {
  return `${html}${MARKER_PREFIX}${nonce}:${payload}-->`;
}

async function appendTo(
  html: string,
  observations: Promise<PrerenderRenderObservations | null>,
  nonce = NONCE,
): Promise<string> {
  return new Response(
    appendPrerenderRenderObservations(new Response(html).body!, nonce, () => observations),
  ).text();
}

describe("prerender render observations channel", () => {
  it("round-trips the observations and restores the exact document", async () => {
    const renderObservations = queryInvariantPrerenderObservations();

    const body = await appendTo(HTML, Promise.resolve(renderObservations));

    expect(body.startsWith(HTML)).toBe(true);
    expect(extractPrerenderRenderObservations(body, NONCE)).toEqual({
      html: HTML,
      renderObservations,
    });
  });

  it("creates a fresh nonce the reader accepts for each request", async () => {
    const nonce = createPrerenderObservationNonce();
    expect(nonce).not.toBe(createPrerenderObservationNonce());
    const renderObservations = queryInvariantPrerenderObservations();

    const body = await appendTo(HTML, Promise.resolve(renderObservations), nonce);

    expect(extractPrerenderRenderObservations(body, nonce)).toEqual({
      html: HTML,
      renderObservations,
    });
  });

  it("appends nothing without observations", async () => {
    await expect(appendTo(HTML, Promise.resolve(null))).resolves.toBe(HTML);
  });

  it("leaves a body without the marker untouched", () => {
    expect(extractPrerenderRenderObservations(HTML, NONCE)).toEqual({
      html: HTML,
      renderObservations: null,
    });
    const userComment = `${HTML}<!-- user comment -->`;
    expect(extractPrerenderRenderObservations(userComment, NONCE)).toEqual({
      html: userComment,
      renderObservations: null,
    });
  });

  it("leaves user HTML ending in a lookalike marker untouched", () => {
    const encoded = encodeURIComponent(JSON.stringify(queryInvariantPrerenderObservations()));
    const lookalikes = [
      // No nonce, as HTML that didn't come from the renderer would end.
      `${HTML}${MARKER_PREFIX}not-json-->`,
      `${HTML}${MARKER_PREFIX}${encoded}-->`,
      // Another request's nonce.
      withMarker(HTML, "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d", encoded),
      withMarker(HTML, "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d", "not-json"),
    ];
    for (const body of lookalikes) {
      expect(extractPrerenderRenderObservations(body, NONCE), body).toEqual({
        html: body,
        renderObservations: null,
      });
    }
  });

  it("reads nothing with a nonce the prerender can't have sent", () => {
    const encoded = encodeURIComponent(JSON.stringify(queryInvariantPrerenderObservations()));
    for (const nonce of ["", "short", "not a nonce -->"]) {
      const body = withMarker(HTML, nonce, encoded);
      expect(extractPrerenderRenderObservations(body, nonce), nonce).toEqual({
        html: body,
        renderObservations: null,
      });
    }
  });

  it("only reads a marker at the very end of the body", () => {
    const encoded = encodeURIComponent(JSON.stringify(queryInvariantPrerenderObservations()));
    const notTrailing = `${withMarker(HTML, NONCE, encoded)}<p>after</p>`;
    expect(extractPrerenderRenderObservations(notTrailing, NONCE)).toEqual({
      html: notTrailing,
      renderObservations: null,
    });
    // A payload that isn't encodeURIComponent output isn't the marker.
    const spansMarkup = withMarker(HTML, NONCE, "x<p>y</p>");
    expect(extractPrerenderRenderObservations(spansMarkup, NONCE)).toEqual({
      html: spansMarkup,
      renderObservations: null,
    });
  });

  it("leaves a marker carrying the request's nonce but no valid observations untouched", () => {
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
      const body = withMarker(HTML, NONCE, payload);
      expect(extractPrerenderRenderObservations(body, NONCE), payload).toEqual({
        html: body,
        renderObservations: null,
      });
    }
  });

  it("accepts every downgrade a render observation can carry", () => {
    const output = queryInvariantPrerenderObservations();
    const build = (
      input: Partial<Parameters<typeof buildRenderObservation>[0]>,
      observed: RenderRequestApiKind[] = [],
    ) => {
      const completeness = input.completeness ?? "complete";
      return (outputScope: CacheProofOutputScope) =>
        buildRenderObservation({
          boundaryOutcome: { kind: "success" },
          cacheability: "public",
          cacheTags: [],
          dynamicFetches: [],
          pathTags: [],
          requestApis: buildRenderRequestApiObservations({ completeness, observed }),
          ...input,
          completeness,
          output: outputScope,
        });
    };
    const renders = [
      build({ cacheability: "private" }),
      build({ cacheability: "uncacheable" }),
      build({ cacheability: "unknown" }),
      build({ dynamicFetches: ["https://example.test/data"] }),
      build({ completeness: "partial" }),
      build({ completeness: "unknown" }),
      build({}, [...ALL_RENDER_REQUEST_API_KINDS]),
    ];
    for (const render of renders) {
      const observations = JSON.parse(
        JSON.stringify({ html: render(output.html.output), rsc: render(output.rsc.output) }),
      );
      expect(observations.html.downgrade.reasons.length).toBeGreaterThan(0);
      expect(isPrerenderRenderObservations(observations), JSON.stringify(observations)).toBe(true);
    }
  });

  it("rejects anything but complete observations of this proof model", () => {
    expect(isPrerenderRenderObservations(queryInvariantPrerenderObservations())).toBe(true);
    for (const { label, observations } of malformedPrerenderObservations()) {
      expect(isPrerenderRenderObservations(observations), label).toBe(false);
      const body = withMarker(HTML, NONCE, encodeURIComponent(JSON.stringify(observations)));
      expect(extractPrerenderRenderObservations(body, NONCE), label).toEqual({
        html: body,
        renderObservations: null,
      });
    }
  });
});
