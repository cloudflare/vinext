import HeadInsertionThemeScript from "./theme-script";

export const dynamic = "force-dynamic";

export default async function HeadInsertionContextPage({
  searchParams,
}: {
  searchParams: Promise<{ theme?: string }>;
}) {
  const theme = (await searchParams).theme ?? "light";

  return (
    <main>
      <h1>Streaming head insertion context</h1>
      <HeadInsertionThemeScript theme={theme} />
    </main>
  );
}
