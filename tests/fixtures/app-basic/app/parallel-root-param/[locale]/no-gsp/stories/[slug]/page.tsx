export default async function Page({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}) {
  const { locale, slug } = await params;
  return (
    <p data-testid="parallel-root-story">
      Story: {locale}/{slug}
    </p>
  );
}
