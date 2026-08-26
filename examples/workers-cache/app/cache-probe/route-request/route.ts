export const revalidate = 60;

export function GET(request: Request) {
  return Response.json({ value: new URL(request.url).searchParams.get("value") });
}
