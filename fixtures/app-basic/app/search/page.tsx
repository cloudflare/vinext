import SearchForm from "./search-form";

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  return (
    <main>
      <h1>Search</h1>
      <SearchForm />
      {q && <p id="search-result">Results for: {q}</p>}
      {!q && <p id="search-empty">Enter a search term</p>}
    </main>
  );
}
