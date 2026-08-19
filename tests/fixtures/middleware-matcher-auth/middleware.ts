import type { NextRequest } from "next/server";

export function middleware(_request: NextRequest) {
  return new Response("blocked by middleware", {
    status: 403,
    headers: { "x-auth-guard": "blocked" },
  });
}

export const config = {
  matcher: [
    "/(admin|dashboard)/:path*",
    "/",
    "/(de|en)/:path*",
    "/docs/:lang(en|fr)*",
    "/manual/:lang(en|fr)+",
    "/(foo.*|bar)/:path*",
    "/report{.:ext}",
    "/archive/:date(\\d{4}(?:-\\d{2}){2})",
    "/codes/:value((?:[A-Z]{2})+)",
    "/shared/:value((?:ab|ac)+)",
    "/mixed/:value((?:[a-z]|[0-9])+)",
    "/shorthand/:value((?:\\d|[a-z])+)",
    "/bracket-shorthand/:value((?:[\\d]|[a-z])+)",
    {
      source: "/conditioned",
      has: [
        { type: "query", key: "role", value: "admin" },
        { type: "query", key: "present", value: "" },
        { type: "header", key: "x-present", value: "" },
        { type: "cookie", key: "session", value: "" },
        { type: "host", value: "" },
      ],
      missing: [{ type: "query", key: "blocked", value: "1" }],
    },
    {
      // Matches the negative-lookahead shape recommended in the Next.js docs.
      // The header keeps this broad matcher isolated to the encoded-path auth
      // regression without changing the fixture's existing public routes.
      source: "/((?!api|_next/static|_next/image|favicon.ico).*)",
      has: [{ type: "header", key: "x-encoded-path-auth", value: "1" }],
    },
    {
      source: "/orders/:id(\\d+)",
      has: [{ type: "header", key: "x-encoded-delimiter-auth", value: "1" }],
    },
    {
      source: "/xx/admin/dash/board",
      has: [{ type: "header", key: "x-encoded-delimiter-auth", value: "1" }],
    },
    {
      source: "/billing/invoices/current/q3",
      has: [{ type: "header", key: "x-encoded-delimiter-auth", value: "1" }],
    },
  ],
};
