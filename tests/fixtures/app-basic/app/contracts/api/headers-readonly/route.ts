import { headers } from "next/headers";
import { NextResponse } from "next/server";

export async function GET() {
  const h = await headers();
  let threw = false;
  try {
    (h as any).set("x-test", "value");
  } catch {
    threw = true;
  }
  return NextResponse.json({ readonlyEnforced: threw });
}
