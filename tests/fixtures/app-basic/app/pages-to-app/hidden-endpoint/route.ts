// An App Router route handler that outranks the Pages Router's
// `pages/pages-to-app/[slug].tsx` for its URL. The hybrid client receives its
// path only as hashed segments (issue #3624), yet must still send a Pages
// `<Link>` to it through a document navigation instead of rendering `[slug]`.
export function GET() {
  return Response.json({ endpoint: "hidden" });
}
