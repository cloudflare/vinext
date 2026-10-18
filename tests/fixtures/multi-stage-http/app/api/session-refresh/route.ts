import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { NextResponse, type NextRequest } from "next/server";

// middleware.ts re-issues the `session` cookie on every request to this route
// (a sliding-expiry refresh). The handler's own cookie must still be the last
// Set-Cookie for that name, as in Next.js, so logout and rotation take effect.
export async function GET(request: NextRequest) {
  const action = request.nextUrl.searchParams.get("action");
  if (action === "rotate") {
    const response = new NextResponse("rotated");
    response.cookies.set("session", "rotated", { path: "/", httpOnly: true });
    return response;
  }
  (await cookies()).delete("session");
  if (action === "redirect") redirect("/");
  return Response.json({ ok: true });
}
