import { PRERENDER_REVALIDATE_HEADER } from "../utils/protocol-headers.js";

export { PRERENDER_REVALIDATE_HEADER };

/**
 * Request-only on-demand revalidation authentication.
 *
 * Keep this module independent from ISR storage and renderer code so a routing
 * stage can authorize a reverse revalidation call without evaluating React.
 */
const DEV_REVALIDATE_SECRET_KEY = Symbol.for("vinext.isrCache.devRevalidateSecret");

function getRevalidateSecret(): string {
  const baked = process.env.__VINEXT_REVALIDATE_SECRET;
  if (baked) return baked;

  const globals = globalThis as unknown as Record<PropertyKey, unknown>;
  const existing = globals[DEV_REVALIDATE_SECRET_KEY];
  if (typeof existing === "string") return existing;

  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const secret = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  globals[DEV_REVALIDATE_SECRET_KEY] = secret;
  return secret;
}

function safeEqual(first: string, second: string): boolean {
  if (first.length !== second.length) return false;
  let mismatch = 0;
  for (let index = 0; index < first.length; index++) {
    mismatch |= first.charCodeAt(index) ^ second.charCodeAt(index);
  }
  return mismatch === 0;
}

function isRevalidateSecret(value: string | null | undefined): boolean {
  if (typeof value !== "string" || value.length === 0) return false;
  return safeEqual(value, getRevalidateSecret());
}

/** Match Next.js: the header value must equal the preview/revalidation secret. */
export function isOnDemandRevalidateRequest(
  headerValue: string | string[] | null | undefined,
): boolean {
  return typeof headerValue === "string" && isRevalidateSecret(headerValue);
}
