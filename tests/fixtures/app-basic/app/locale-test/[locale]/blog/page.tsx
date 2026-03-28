export default async function LocaleBlogPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  return (
    <div>
      <h1 data-testid="locale-blog-heading">Locale Blog Index</h1>
      <p data-testid="locale">Locale: {locale}</p>
    </div>
  );
}
