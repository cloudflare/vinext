export const revalidate = 2;
export function GET() {
  return Response.json(
    { renderId: crypto.randomUUID() },
    {
      status: 400,
      headers: { "Cache-Control": "private, max-age=300" },
    },
  );
}
