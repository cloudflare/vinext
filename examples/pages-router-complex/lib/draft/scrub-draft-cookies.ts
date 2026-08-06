import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

/**
 * Removes the framework's draft-mode cookies (`__prerender_bypass`,
 * `__next_preview_data`) from service-route requests while draft mode is on.
 *
 * Those cookies only matter for page rendering. The framework's API-route
 * pipeline eagerly validates them on every request without honouring
 * multi-zone draft setups, and clears them when the embedded draft id does
 * not match (after a redeploy, or when the request was rewritten across
 * apps). Filtering the cookie header in middleware sidesteps that reset.
 */
export const scrubDraftCookiesForServiceRoutes = (
  req: NextRequest,
): NextResponse | null => {
  const { pathname } = req.nextUrl;
  const bypassCookie = req.cookies.get("__prerender_bypass");

  if (
    pathname.startsWith("/api/") &&
    !pathname.startsWith("/api/draft") &&
    bypassCookie?.value
  ) {
    const forwardedHeaders = new Headers(req.headers);
    const cookieHeader = forwardedHeaders.get("cookie") ?? "";
    const filtered = cookieHeader
      .split("; ")
      .filter(
        (c) =>
          !c.startsWith("__prerender_bypass=") &&
          !c.startsWith("__next_preview_data="),
      )
      .join("; ");
    forwardedHeaders.set("cookie", filtered);
    return NextResponse.next({ request: { headers: forwardedHeaders } });
  }

  return null;
};
