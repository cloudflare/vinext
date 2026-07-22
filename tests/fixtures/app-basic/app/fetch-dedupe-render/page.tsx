export default async function FetchDedupeRenderPage() {
  const target = process.env.TEST_FETCH_DEDUPE_TARGET;
  if (!target) {
    throw new Error("missing TEST_FETCH_DEDUPE_TARGET");
  }

  const first = await fetch(target, { cache: "no-store" });
  const second = await fetch(target, { cache: "no-store" });
  const firstBody = (await first.json()) as { count: number };
  const secondBody = (await second.json()) as { count: number };

  return (
    <main>
      <h1>Fetch Dedupe Render</h1>
      <p data-testid="fetch-dedupe-counts">{JSON.stringify([firstBody.count, secondBody.count])}</p>
    </main>
  );
}
