export const revalidate = 60;

export function GET() {
  return Response.json(
    { renderId: crypto.randomUUID() },
    { headers: { "Cache-Control": "private, max-age=300" } },
  );
}
