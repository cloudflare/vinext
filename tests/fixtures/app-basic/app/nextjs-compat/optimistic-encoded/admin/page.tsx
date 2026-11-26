// Renders per request, so there is no prerender of it for `[slug]` to answer
// an encoded spelling like `%61dmin` from: the server renders `[slug]` for it.
export const dynamic = "force-dynamic";

export default function OptimisticEncodedAdminPage() {
  return <p id="admin-page">Admin</p>;
}
