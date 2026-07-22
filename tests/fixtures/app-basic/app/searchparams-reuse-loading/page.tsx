export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await new Promise((resolve) => setTimeout(resolve, 500));
  return <h1 id="params">{JSON.stringify(await searchParams)}</h1>;
}
