export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  "use cache: private";

  const { q } = await searchParams;

  return (
    <p>
      Query: <span data-testid="search-param">{q}</span>
    </p>
  );
}
