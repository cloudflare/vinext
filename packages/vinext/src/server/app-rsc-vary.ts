/** Request selectors that define a reusable full-route RSC response variant. */
export const RSC_HEADER = "RSC";
export const NEXT_ROUTER_STATE_TREE_HEADER = "Next-Router-State-Tree";
export const NEXT_ROUTER_PREFETCH_HEADER = "Next-Router-Prefetch";
export const NEXT_ROUTER_SEGMENT_PREFETCH_HEADER = "Next-Router-Segment-Prefetch";
export const NEXT_URL_HEADER = "Next-Url";
export const VINEXT_INTERCEPTION_CONTEXT_HEADER = "X-Vinext-Interception-Context";
export const VINEXT_INTERCEPTION_ID_HEADER = "X-Vinext-Interception-Id";
export const VINEXT_MOUNTED_SLOTS_HEADER = "X-Vinext-Mounted-Slots";
export const VINEXT_RSC_RENDER_MODE_HEADER = "X-Vinext-Rsc-Render-Mode";
export const VINEXT_RSC_STATE_FINGERPRINT_HEADER = "X-Vinext-Rsc-State-Fingerprint";

export const VINEXT_RSC_VARY_HEADER = [
  RSC_HEADER,
  NEXT_ROUTER_STATE_TREE_HEADER,
  NEXT_ROUTER_PREFETCH_HEADER,
  NEXT_ROUTER_SEGMENT_PREFETCH_HEADER,
  NEXT_URL_HEADER,
  VINEXT_INTERCEPTION_CONTEXT_HEADER,
  VINEXT_INTERCEPTION_ID_HEADER,
  VINEXT_MOUNTED_SLOTS_HEADER,
  VINEXT_RSC_RENDER_MODE_HEADER,
  VINEXT_RSC_STATE_FINGERPRINT_HEADER,
].join(", ");

const VINEXT_RSC_VARY_FIELDS = new Set(
  VINEXT_RSC_VARY_HEADER.split(",").map((name) => name.trim().toLowerCase()),
);

/** Whether a normalized response `Vary` field is a framework RSC selector. */
export function isVinextRscVaryField(name: string): boolean {
  return VINEXT_RSC_VARY_FIELDS.has(name.trim().toLowerCase());
}
