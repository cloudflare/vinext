// One-shot control for the Response Store regeneration regression fixture.
// Default requests remain uncacheable, including deployment discovery probes.
let seedNextGet = false;

export function POST(): Response {
  seedNextGet = true;
  return new Response(null, { status: 204 });
}

export function GET(): Response {
  const seeded = seedNextGet;
  seedNextGet = false;
  return Response.json(
    { renderId: crypto.randomUUID() },
    { headers: {
      "Cache-Control": "no-store",
      "Cloudflare-CDN-Cache-Control": seeded
        ? "public, max-age=1, stale-while-revalidate=60"
        : "no-store",
    } },
  );
}
