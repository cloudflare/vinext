export const revalidate = 60;

const moduleScopedFetch = fetch;

export default async function FetchAliasPage() {
  const response = await moduleScopedFetch("data:text/plain,module-alias", {
    cache: "no-store",
  });
  return <main>{await response.text()}</main>;
}
