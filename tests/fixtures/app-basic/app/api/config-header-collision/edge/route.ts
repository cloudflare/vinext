// Used by Vitest: app-router-production-server.test.ts
export const runtime = "edge";

export function GET() {
  return new Response(null, {
    headers: {
      "X-Config-Collision": "handler",
      "WWW-Authenticate": "Basic realm=handler",
      Vary: "X-Handler",
      "X-Nextjs-Cache": "handler",
    },
  });
}
