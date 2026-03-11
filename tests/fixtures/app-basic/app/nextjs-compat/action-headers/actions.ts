"use server";

import { headers, cookies } from "next/headers";

/**
 * Server action that reads headers() — this should work and NOT throw
 * "can only be called from a Server Component" error.
 *
 * Ported from Next.js behavior: headers() must work in server actions.
 * See: https://github.com/cloudflare/vinext/issues/443
 */
export async function getHeaderFromAction(headerName: string): Promise<string | null> {
  const h = await headers();
  return h.get(headerName);
}

/**
 * Server action that reads cookies() — this should work and return cookies.
 */
export async function getCookieFromAction(cookieName: string): Promise<string | null> {
  const c = await cookies();
  return c.get(cookieName)?.value ?? null;
}

/**
 * Server action that calls headers() synchronously (legacy pattern).
 */
export async function getHeaderFromActionSync(headerName: string): Promise<string | null> {
  const h = headers() as Promise<Headers> & Headers;
  return h.get(headerName);
}
