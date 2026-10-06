export const revalidate = 2;
export function GET() {
  return Response.json(
    { renderId: crypto.randomUUID() },
    {
      status: 500,
      headers: { "Cache-Control": "private, max-age=300" },
    },
  );
}
