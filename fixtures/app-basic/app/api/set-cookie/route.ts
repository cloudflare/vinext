import { cookies } from "next/headers";
import { NextResponse } from "next/server";

export async function GET() {
  const cookieStore = await cookies();
  cookieStore.set("session", "abc123", { path: "/", httpOnly: true });
  cookieStore.set("theme", "dark");

  return NextResponse.json({ ok: true, message: "Cookies set" });
}

export async function POST() {
  const cookieStore = await cookies();
  cookieStore.delete("session");

  return NextResponse.json({ ok: true, message: "Cookie deleted" });
}
