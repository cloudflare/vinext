export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  return (
    <>
      <h1>Search</h1>
      <p>
        Results for <span id="query">{q ?? ""}</span>
      </p>
    </>
  );
}
