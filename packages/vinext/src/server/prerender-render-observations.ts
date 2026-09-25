/**
 * Build-internal channel carrying a prerendered App page's render
 * observations from the prerender server to `build/prerender.ts`, which stores
 * them in `vinext-prerender.json` for the seed readers.
 *
 * The observations are only final once the render has finished, after the
 * response headers are sent, so they travel as a private marker appended to
 * the end of the prerender's HTML body. Response headers can't carry them:
 * two observations with their tags can pass the HTTP client's header limit.
 *
 * The prerender sends a fresh random nonce with each page request
 * (`VINEXT_PRERENDER_OBSERVATION_NONCE_HEADER`), and the marker carries it.
 * The prerender strips only a marker with its own nonce, before the HTML is
 * written or read in any other way, so HTML that didn't come from the App
 * renderer (a middleware response, say) is never mistaken for the channel,
 * whatever it ends with. Only prerender servers (`VINEXT_PRERENDER=1`)
 * append the marker, and only for a request that sent a nonce.
 */
import {
  ALL_RENDER_REQUEST_API_KINDS,
  type RenderObservation,
  type RenderObservationCompleteness,
  type RenderRequestApiStatus,
} from "./cache-proof.js";

/** The observations of a prerendered App page's render, one per stored artifact. */
export type PrerenderRenderObservations = {
  html: RenderObservation;
  rsc: RenderObservation;
};

const MARKER_PREFIX = "<!--vinext-prerender-render-observations:";
const MARKER_SUFFIX = "-->";
// encodeURIComponent output, so a match can't span other markup.
const ENCODED_PAYLOAD = /^[A-Za-z0-9\-_.!~*'()%]*$/;
// Long enough to be unguessable, and safe inside an HTML comment.
const NONCE = /^[A-Za-z0-9-]{16,128}$/;

/** A fresh nonce for one prerender page request. */
export function createPrerenderObservationNonce(): string {
  return crypto.randomUUID();
}

export function isPrerenderObservationNonce(value: unknown): value is string {
  return typeof value === "string" && NONCE.test(value);
}

/**
 * Append the observations, framed with the request's nonce, to the end of a
 * prerender's HTML stream once the upstream has closed and `observations` has
 * settled. `null` appends nothing.
 */
export function appendPrerenderRenderObservations(
  stream: ReadableStream<Uint8Array>,
  nonce: string,
  observations: Promise<PrerenderRenderObservations | null>,
): ReadableStream<Uint8Array> {
  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      async flush(controller) {
        const settled = await observations;
        if (!settled) return;
        controller.enqueue(
          new TextEncoder().encode(
            `${MARKER_PREFIX}${nonce}:${encodeURIComponent(JSON.stringify(settled))}${MARKER_SUFFIX}`,
          ),
        );
      },
    }),
  );
}

/**
 * Split a prerendered HTML body into the document and the observations the
 * render appended for the request that sent `nonce`. A body that doesn't end
 * with that request's marker keeps every byte and has no observations. A
 * marker with the nonce but a malformed payload is still stripped: only the
 * renderer knew the nonce.
 */
export function extractPrerenderRenderObservations(
  body: string,
  nonce: string,
): {
  html: string;
  renderObservations: PrerenderRenderObservations | null;
} {
  const unchanged = { html: body, renderObservations: null };
  if (!isPrerenderObservationNonce(nonce) || !body.endsWith(MARKER_SUFFIX)) return unchanged;
  const prefix = `${MARKER_PREFIX}${nonce}:`;
  const start = body.lastIndexOf(prefix);
  if (start === -1) return unchanged;
  const payload = body.slice(start + prefix.length, body.length - MARKER_SUFFIX.length);
  if (!ENCODED_PAYLOAD.test(payload)) return unchanged;

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

const RENDER_OBSERVATION_COMPLETENESS: ReadonlySet<unknown> =
  new Set<RenderObservationCompleteness>(["complete", "partial", "unknown"]);
const RENDER_REQUEST_API_KINDS: ReadonlySet<unknown> = new Set(ALL_RENDER_REQUEST_API_KINDS);
const RENDER_REQUEST_API_STATUSES: ReadonlySet<unknown> = new Set<RenderRequestApiStatus>([
  "notObserved",
  "observed",
  "unknown",
]);

/**
 * Whether `value` holds every field the searchParams proof reads, with values
 * it accepts, so reading a malformed observation yields no proof instead of
 * throwing.
 */
function isRenderObservationShape(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const observation = value as { completeness?: unknown; requestApis?: unknown };
  return (
    RENDER_OBSERVATION_COMPLETENESS.has(observation.completeness) &&
    Array.isArray(observation.requestApis) &&
    observation.requestApis.every((requestApi: unknown) => {
      if (typeof requestApi !== "object" || requestApi === null) return false;
      const { kind, status } = requestApi as { kind?: unknown; status?: unknown };
      return RENDER_REQUEST_API_KINDS.has(kind) && RENDER_REQUEST_API_STATUSES.has(status);
    })
  );
}
