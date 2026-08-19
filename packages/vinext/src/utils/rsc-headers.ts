/**
 * Header names shared by the browser-side RSC request identity code and the
 * server request handlers. Keep this module dependency-free: Pages Router
 * clients can load the prewarm capability facade without pulling server
 * runtime modules into their browser graph.
 */
export const RSC_HEADER = "RSC";
export const NEXT_ROUTER_STATE_TREE_HEADER = "Next-Router-State-Tree";
export const NEXT_ROUTER_PREFETCH_HEADER = "Next-Router-Prefetch";
export const NEXT_ROUTER_SEGMENT_PREFETCH_HEADER = "Next-Router-Segment-Prefetch";
export const NEXT_URL_HEADER = "Next-Url";
export const VINEXT_MOUNTED_SLOTS_HEADER = "X-Vinext-Mounted-Slots";
export const VINEXT_INTERCEPTION_CONTEXT_HEADER = "X-Vinext-Interception-Context";
export const VINEXT_INTERCEPTION_ID_HEADER = "X-Vinext-Interception-Id";
export const VINEXT_RSC_RENDER_MODE_HEADER = "X-Vinext-Rsc-Render-Mode";
export const VINEXT_RSC_STATE_FINGERPRINT_HEADER = "X-Vinext-Rsc-State-Fingerprint";
export const VINEXT_CLIENT_REUSE_MANIFEST_HEADER = "X-Vinext-Client-Reuse-Manifest";
