export const revalidate = 60;

export async function GET(request: Request) {
  // Fetch-handler libraries such as Hono/oRPC commonly re-wrap the request.
  // Native Request construction bypasses JavaScript accessors on its input.
  const rewrapped = new Request(request);
  const url = new URL(rewrapped.url);

  return Response.json({
    ping: url.searchParams.get("ping"),
  });
}
