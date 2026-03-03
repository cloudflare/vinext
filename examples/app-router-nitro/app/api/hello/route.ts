import { NextResponse, after } from "next/server";
import { cookies } from "next/headers";
import { revalidateTag } from "next/cache";

// GET — returns JSON with request info
export async function GET(request: Request) {
  const url = new URL(request.url);
  const name = url.searchParams.get("name") ?? "world";

  return NextResponse.json({
    message: `Hello, ${name}! From vinext with nitro.`,
    pathname: url.pathname,
    runtime:
      typeof globalThis.navigator !== "undefined"
        ? (globalThis.navigator as { userAgent?: string }).userAgent
        : "unknown",
    timestamp: new Date().toISOString(),
  });
}

// POST — demonstrates mutation with cookies and after()
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const { action } = body as { action?: string };

  const c = await cookies();

  if (action === "increment-visits") {
    const current = Number.parseInt(c.get("visit-count")?.value ?? "0", 10);
    c.set("visit-count", String(current + 1), { path: "/" });
  }

  if (action === "set-theme") {
    const { theme } = body as { theme?: string };
    c.set("theme", theme ?? "light", { path: "/" });
  }

  // after() — run work after the response is sent
  after(() => {
    console.log(`[after] POST /api/hello action=${action}`);
  });

  return NextResponse.json({ ok: true, action });
}

// DELETE — demonstrates revalidation
export async function DELETE() {
  revalidateTag("blog-posts");

  return NextResponse.json({ ok: true, revalidated: "blog-posts" });
}
