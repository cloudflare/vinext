export default async function LocaleCatchAllPage({
  params,
}: {
  params: Promise<{ locale: string; path: string[] }>;
}) {
  const { locale, path } = await params;
  return (
    <div>
      <h1 data-testid="locale-catchall-heading">Locale Catch-All</h1>
      <p data-testid="locale">Locale: {locale}</p>
      <p data-testid="path">Path: {path.join("/")}</p>
      <p data-testid="segments">Segments: {path.length}</p>
    </div>
  );
}
