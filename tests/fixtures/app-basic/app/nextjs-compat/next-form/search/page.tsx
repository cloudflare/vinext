export default async function NextFormSearchPage({
  searchParams,
}: {
  searchParams: Promise<{ query?: string; source?: string }>;
}) {
  const { query, source } = await searchParams;
  return (
    <main>
      <p id="search-result">Query: {query}</p>
      {source && <p id="search-source">Source: {source}</p>}
    </main>
  );
}
