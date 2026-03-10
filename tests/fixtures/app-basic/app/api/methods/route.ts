/**
 * Route handler supporting all HTTP methods.
 *
 * Ported from: https://github.com/opennextjs/opennextjs-cloudflare/blob/main/examples/e2e/app-router/open-next/app/methods/route.ts
 * Tests: ON-3 in TRACKING.md
 */

import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json(
    { message: "vinext route handler" },
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "special-header": "vinext is great",
      },
    },
  );
}

export async function POST(request: Request) {
  const contentType = request.headers.get("content-type") || "";

  if (
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data")
  ) {
    const formData = await request.formData();
    const name = formData.get("name");
    const email = formData.get("email");
    return NextResponse.json({ message: "ok", name, email }, { status: 202 });
  }

  const body = await request.text();
  if (body.includes("not awesome")) {
    return NextResponse.json({ message: "forbidden" }, { status: 403 });
  }
  return NextResponse.json({ message: "ok" }, { status: 202 });
}

export async function PUT(request: Request) {
  const body = await request.json();
  return NextResponse.json({ message: "ok", ...body }, { status: 201 });
}

export async function PATCH(_request: Request) {
  return NextResponse.json(
    { message: "ok", modified: true, timestamp: new Date().toISOString() },
    { status: 202 },
  );
}

export async function DELETE(_request: Request) {
  return new Response(null, { status: 204 });
}

export async function HEAD() {
  return new Response(null, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "special-header": "vinext is great",
    },
  });
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      allow: "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
      special: "vinext is great",
    },
  });
}
