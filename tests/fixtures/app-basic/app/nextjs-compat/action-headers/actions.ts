"use server";

import { headers, cookies } from "next/headers";

/**
 * Server action that reads headers() — must work without throwing
 * "can only be called from a Server Component".
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
