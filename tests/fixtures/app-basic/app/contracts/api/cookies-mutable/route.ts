import { cookies } from "next/headers";
import { NextResponse } from "next/server";

export async function GET() {
  const cookieStore = await cookies();
  cookieStore.set("contract-test", "value", { path: "/" });
  return NextResponse.json({ ok: true });
}
