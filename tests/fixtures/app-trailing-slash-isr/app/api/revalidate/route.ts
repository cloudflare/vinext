import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const lang = url.searchParams.get("lang") ?? "en";
  const withSlash = url.searchParams.get("withSlash") !== "false";

  const path = withSlash ? `/${lang}/legacy/` : `/${lang}/legacy`;
  await revalidatePath(path);

  return NextResponse.json({ timestamp: new Date().toISOString() });
}
