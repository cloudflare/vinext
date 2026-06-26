export default async function RelativeSearchPage({
  searchParams,
}: {
  searchParams: Promise<{ query?: string }>;
}) {
  const { query } = await searchParams;
  return <p id="relative-result">Relative: {query}</p>;
}
