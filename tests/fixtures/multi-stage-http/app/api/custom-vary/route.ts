export const revalidate = 60;

export function GET(): Response {
  return Response.json(
    { "data-render-token": crypto.randomUUID() },
    { headers: { Vary: "X-Http-Variant" } },
  );
}
