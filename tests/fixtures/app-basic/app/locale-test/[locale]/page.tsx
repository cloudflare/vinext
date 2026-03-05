export default async function LocalePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  return (
    <div>
      <h1 data-testid="locale-heading">Locale Root</h1>
      <p data-testid="locale">Locale: {locale}</p>
    </div>
  );
}
