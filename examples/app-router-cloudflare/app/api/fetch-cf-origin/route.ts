// A fresh id per upstream hit, so /fetch-cf-cache-key can tell which of its
// fetches shared a cached or deduped response.
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ id: crypto.randomUUID() });
}
