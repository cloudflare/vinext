// ISR page that also reads searchParams — searchParams access should opt
// out of ISR caching (dynamic rendering wins over revalidate config).
// Ported from Next.js: searchParams is a Request-time API that opts the
// page into dynamic rendering at request time.
export const revalidate = 60;

export default async function ISRDynamicSearchPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>;
}) {
  const { filter } = await searchParams;
  const timestamp = Date.now();
  return (
    <div data-testid="isr-dynamic-search-page">
      <h1>ISR + Dynamic Search</h1>
      <p data-testid="filter">{filter ?? "none"}</p>
      <p data-testid="timestamp">{timestamp}</p>
    </div>
  );
}
