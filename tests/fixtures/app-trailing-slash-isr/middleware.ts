// The source keeps a slash after its prefix, so /guarded/ matches only as
// requested. vinext runs middleware for it, where Next.js ends the request
// with an empty 200. /guarded/<page>/ runs it in both.
export function middleware() {
  return new Response("blocked by middleware", { status: 403 });
}

export const config = {
  matcher: ["/guarded/(.*)"],
};
