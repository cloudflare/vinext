// Reads searchParams, so it renders per request and Next.js has no prerender
// of it for `[slug]` to answer an encoded spelling from. Middleware guards its
// path.
export default async function EncodedSiblingGuardedPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { view } = await searchParams;
  return <p data-testid="encoded-sibling">{`guarded sibling page ${view ?? "default"}`}</p>;
}
