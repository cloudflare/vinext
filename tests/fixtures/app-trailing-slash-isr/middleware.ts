// The source keeps a slash after its prefix, so /guarded/ matches only as
// requested and gets an empty response without running middleware, as in
// Next.js. /guarded/<page>/ still runs it.
export function middleware() {
  return new Response("blocked by middleware", { status: 403 });
}

export const config = {
  matcher: ["/guarded/(.*)"],
};
