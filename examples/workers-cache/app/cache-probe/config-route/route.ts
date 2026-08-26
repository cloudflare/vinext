export const revalidate = 0;

export function GET() {
  return new Response("Route Handler with an explicit config cache policy", {
    // Next.js applies next.config headers before copying Route Handler response
    // headers, so the config's s-maxage=300 remains authoritative.
    headers: { "Cache-Control": "no-store" },
  });
}
