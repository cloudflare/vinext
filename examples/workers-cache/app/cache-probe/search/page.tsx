export const revalidate = 60;

export default async function CacheProbeSearchPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const value = (await searchParams).value ?? "missing";
  return <main>cache-probe search {String(value)}</main>;
}
