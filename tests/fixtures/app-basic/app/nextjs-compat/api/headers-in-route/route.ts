import { headers, cookies } from "next/headers";

/**
 * Route handler that reads request headers and cookies via next/headers.
 * This exercises the "route-handler" phase of the headers shim.
 */
export async function GET() {
  const h = await headers();
  const c = await cookies();

  return Response.json({
    customHeader: h.get("x-custom-header"),
    cookieValue: c.get("test-cookie")?.value ?? null,
    userAgent: h.get("user-agent")?.slice(0, 20) ?? null,
  });
}
