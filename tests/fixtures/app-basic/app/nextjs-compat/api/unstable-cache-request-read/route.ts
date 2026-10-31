import { unstable_cache } from "next/cache";
import type { NextRequest } from "next/server";

async function readInsideCache(name: string, read: () => unknown) {
  try {
    const cached = unstable_cache(
      async () => String(await read()),
      ["nextjs-compat-unstable-cache-request-read", name],
    );
    return { status: "ok", value: await cached() };
  } catch (error) {
    return { status: "threw", message: error instanceof Error ? error.message : String(error) };
  }
}

export async function GET(request: NextRequest) {
  return Response.json({
    cookies: await readInsideCache("cookies", () => request.cookies.get("session")?.value),
    headers: await readInsideCache("headers", () => request.headers.get("authorization")),
    url: await readInsideCache("url", () => request.url),
    text: await readInsideCache("text", () => request.text()),
    searchParams: await readInsideCache("searchParams", () =>
      request.nextUrl.searchParams.get("q"),
    ),
    cloneCookies: await readInsideCache(
      "cloneCookies",
      () => request.clone().cookies.get("session")?.value,
    ),
    method: await readInsideCache("method", () => request.method),
    pathname: await readInsideCache("pathname", () => request.nextUrl.pathname),
    host: await readInsideCache("host", () => request.nextUrl.host),
    bytes: await readInsideCache("bytes", async () => (await request.bytes()).length),
  });
}
