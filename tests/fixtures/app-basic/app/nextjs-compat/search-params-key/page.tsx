import { ClientComponent } from "./client-component";

export default async function SearchParamsKeyPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}) {
  const params = await searchParams;
  return (
    <div>
      <h1>Search Params Key Test</h1>
      <div id="search-params">{JSON.stringify(params)}</div>
      <ClientComponent />
    </div>
  );
}
