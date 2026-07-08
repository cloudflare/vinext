export const config = {
  runtime: "edge",
};

type NextRequestLike = Request & { nextUrl: URL };

export default function handler(req: NextRequestLike): Response {
  return Response.json({
    pathname: req.nextUrl.pathname,
    query: Object.fromEntries(req.nextUrl.searchParams),
  });
}
