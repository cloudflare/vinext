export const config = {
  runtime: "edge",
};

/**
 * Edge-runtime Pages Router API route that echoes request headers as JSON.
 * Mirrors the upstream `app-middleware` `dump-headers-edge` endpoint.
 * Regression coverage for #1520.
 */
export default function handler(req: Request) {
  return Response.json(Object.fromEntries(req.headers.entries()));
}
