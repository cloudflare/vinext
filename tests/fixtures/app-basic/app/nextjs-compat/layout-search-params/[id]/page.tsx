export default async function LayoutSearchParamsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}) {
  const params = await searchParams;

  return (
    <div>
      <div id="search-params">{JSON.stringify(params)}</div>
      <p id="page-content">Query-only navigation should preserve parent layout state.</p>
    </div>
  );
}
