/**
 * Shared auth helpers for the /api/compatibility endpoints.
 *
 * Both the run-ingest endpoint (POST /api/compatibility) and the
 * classification-ingest endpoint (POST /api/compatibility/classify)
 * accept the same `X-Compat-Secret` header authenticating the GitHub
 * Actions workflow.
 *
 * The constant-time comparison avoids leaking secret length / prefix via
 * timing differences in `!==`. Workers expose `crypto.subtle` but not
 * Node's `crypto.timingSafeEqual`, so we hand-roll a fixed-cost compare.
 *
 * Inputs are first run through SHA-256 to normalise length (otherwise an
 * attacker could distinguish "wrong-length" from "wrong-content" via the
 * fast-path check). HMAC isn't necessary here because both sides go
 * through the same hash with no key.
 */
import { getIngestSecret } from "@/app/lib/db/client";

async function safeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const ua = new Uint8Array(ha);
  const ub = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < ua.length; i++) diff |= ua[i] ^ ub[i];
  return diff === 0;
}

/**
 * Verifies the `X-Compat-Secret` header on the incoming request. Returns
 * `null` on success, or a Response describing the failure (401 / 503).
 *
 * Usage:
 *   const denied = await requireIngestAuth(request);
 *   if (denied) return denied;
 *   // ...proceed with handler
 */
export async function requireIngestAuth(request: Request): Promise<Response | null> {
  const expected = getIngestSecret();
  if (!expected) {
    return Response.json(
      { error: "COMPAT_INGEST_SECRET is not configured on the worker" },
      { status: 503 },
    );
  }

  const provided = request.headers.get("x-compat-secret") ?? "";
  // Fast-path reject for missing/empty headers: skip the two SHA-256
  // digests in safeEqual since there's nothing to compare. The timing
  // guarantee we care about — "don't leak the contents of `expected`
  // via length / prefix matching against `provided`" — is unaffected
  // because we're only short-circuiting on values we already know
  // can't match a non-empty secret. This is a micro-optimisation
  // (workers per request is fine either way) but it makes the
  // "no auth header" failure mode cheap and obvious.
  if (!provided || !(await safeEqual(provided, expected))) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}
