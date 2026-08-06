export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ first?: string; second?: string }>;
}) {
  const { first = "", second = "" } = await searchParams;

  return (
    <main>
      <p>{first}</p>
      <p>{second}</p>
    </main>
  );
}
