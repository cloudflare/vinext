export const revalidate = 60;

export default async function SearchParamsPage(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await props.searchParams;
  const filter = sp.filter ?? "none";

  return (
    <div>
      <h1>Search Params Page</h1>
      <p id="filter">filter={String(filter)}</p>
      <p id="keys">keys={Object.keys(sp).sort().join(",")}</p>
    </div>
  );
}
