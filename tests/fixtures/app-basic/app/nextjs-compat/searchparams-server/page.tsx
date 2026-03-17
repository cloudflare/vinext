export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}) {
  const params = await searchParams;
  return (
    <>
      <h1>Parameter: {params.search}</h1>
      <p id="render-id">{crypto.randomUUID()}</p>
    </>
  );
}
