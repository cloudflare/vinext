export const config = {
  runtime: "edge",
};

export default function handler(request: Request) {
  const cf = Reflect.get(request, "cf");
  return Response.json(
    { hasCf: cf !== undefined },
    { headers: { "Cache-Control": "public, s-maxage=60" } },
  );
}
