import SearchForm from "./search-form";

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; lang?: string; source?: string }>;
}) {
  const { q, lang, source } = await searchParams;
  return (
    <main>
      <h1>Search</h1>
      <SearchForm />
      {q && <p id="search-result">Results for: {q}</p>}
      {!q && <p id="search-empty">Enter a search term</p>}
      {lang && <p id="search-lang">Lang: {lang}</p>}
      {source && <p id="search-source">Source: {source}</p>}
    </main>
  );
}
