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
