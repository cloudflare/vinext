import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { NextResponse } from "next/server";

// middleware.ts re-issues the `session` cookie on every request to this route
// (a sliding-expiry refresh). The handler's own cookie must still be the last
// Set-Cookie for that name, as in Next.js, so logout and rotation take effect.

// Logout.
export async function POST() {
  (await cookies()).delete("session");
  return Response.json({ ok: true });
}

// Session rotation.
export function PUT() {
  const response = new NextResponse("rotated");
  response.cookies.set("session", "rotated", { path: "/", httpOnly: true });
  return response;
}

// Logout followed by redirect().
export async function DELETE() {
  (await cookies()).delete("session");
  redirect("/about");
}
