import { cookies, headers } from "next/headers";
import { NextResponse } from "next/server";

export function GET() {
  const headerStore = headers() as Promise<Headers> & Headers;
  const cookieStore = cookies() as Promise<any> & {
    get(name: string): { name: string; value: string } | undefined;
    set(name: string, value: string, options?: Record<string, unknown>): unknown;
  };

  cookieStore.set("sync-session", "set-via-sync", { path: "/", httpOnly: true });

  return NextResponse.json({
    syncHeader: headerStore.get("x-sync-header"),
    syncCookie: cookieStore.get("sync-session")?.value ?? null,
  });
}
