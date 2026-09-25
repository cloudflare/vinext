/**
 * Build-internal channel carrying a prerendered App page's render
 * observations from the prerender server to `build/prerender.ts`, which stores
 * them in `vinext-prerender.json` for the seed readers.
 *
 * The observations are only final once the render has finished, after the
 * response headers are sent, so they travel as a private marker appended to
 * the end of the prerender's HTML body. The prerender strips it before the
 * HTML is written or read in any other way. Only prerender servers
 * (`VINEXT_PRERENDER=1`) append it.
 */
import type { RenderObservation } from "./cache-proof.js";

/** The observations of a prerendered App page's render, one per stored artifact. */
export type PrerenderRenderObservations = {
  html: RenderObservation;
  rsc: RenderObservation;
};

const MARKER_PREFIX = "<!--vinext-prerender-render-observations:";
const MARKER_SUFFIX = "-->";
// encodeURIComponent output, so a match can't span other markup.
const ENCODED_PAYLOAD = /^[A-Za-z0-9\-_.!~*'()%]*$/;

/**
 * Append the observations to the end of a prerender's HTML stream, once the
 * upstream has closed and `observations` has settled. `null` appends nothing.
 */
export function appendPrerenderRenderObservations(
  stream: ReadableStream<Uint8Array>,
  observations: Promise<PrerenderRenderObservations | null>,
): ReadableStream<Uint8Array> {
  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      async flush(controller) {
        const settled = await observations;
        if (!settled) return;
        controller.enqueue(
          new TextEncoder().encode(
            MARKER_PREFIX + encodeURIComponent(JSON.stringify(settled)) + MARKER_SUFFIX,
          ),
        );
      },
    }),
  );
}

/**
 * Split a prerendered HTML body into the document and its trailing
 * observations. A body without a well-formed marker keeps its bytes and has
 * no observations; a marker whose payload is malformed is still stripped.
 */
export function extractPrerenderRenderObservations(body: string): {
  html: string;
  renderObservations: PrerenderRenderObservations | null;
} {
  if (!body.endsWith(MARKER_SUFFIX)) return { html: body, renderObservations: null };
  const start = body.lastIndexOf(MARKER_PREFIX);
  if (start === -1) return { html: body, renderObservations: null };
  const payload = body.slice(start + MARKER_PREFIX.length, body.length - MARKER_SUFFIX.length);
  if (!ENCODED_PAYLOAD.test(payload)) return { html: body, renderObservations: null };

  const html = body.slice(0, start);
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(payload));
    return { html, renderObservations: isPrerenderRenderObservations(parsed) ? parsed : null };
  } catch {
    return { html, renderObservations: null };
  }
}

export function isPrerenderRenderObservations(
  value: unknown,
): value is PrerenderRenderObservations {
  if (typeof value !== "object" || value === null) return false;
  const { html, rsc } = value as { html?: unknown; rsc?: unknown };
  return isRenderObservationShape(html) && isRenderObservationShape(rsc);
}

function isRenderObservationShape(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const observation = value as { completeness?: unknown; requestApis?: unknown };
  return (
    typeof observation.completeness === "string" &&
    Array.isArray(observation.requestApis) &&
    observation.requestApis.every(
      (requestApi: unknown) =>
        typeof requestApi === "object" &&
        requestApi !== null &&
        typeof (requestApi as { kind?: unknown }).kind === "string" &&
        typeof (requestApi as { status?: unknown }).status === "string",
    )
  );
}
