import { cookies } from "next/headers";
import { NextResponse } from "next/server";

export async function GET() {
  const jar = await cookies();
  jar.set("session", "mutable", { path: "/" });
  jar.set("mutable-only", "first", { path: "/" });
  jar.set("mutable-only", "final", { path: "/", secure: true });

  const response = NextResponse.json({ ok: true });
  response.cookies.set("session", "returned", { path: "/", httpOnly: true });
  response.cookies.set("response-only", "1", { path: "/" });
  return response;
}
