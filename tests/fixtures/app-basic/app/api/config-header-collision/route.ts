// Used by Vitest: app-router-production-server.test.ts
export function GET(request: Request) {
  const status = Number(new URL(request.url).searchParams.get("status") ?? 200);
  return new Response(null, {
    status,
    headers: {
      ...(status === 302 && { Location: "/about" }),
      "X-Config-Collision": "handler",
      "WWW-Authenticate": "Basic realm=handler",
      Vary: "X-Handler",
      "X-Nextjs-Cache": "handler",
    },
  });
}
