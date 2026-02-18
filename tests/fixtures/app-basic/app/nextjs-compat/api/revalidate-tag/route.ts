import { revalidateTag } from "next/cache";
import { NextResponse } from "next/server";

export async function GET() {
  revalidateTag("test-data");
  return NextResponse.json({ revalidated: true });
}
