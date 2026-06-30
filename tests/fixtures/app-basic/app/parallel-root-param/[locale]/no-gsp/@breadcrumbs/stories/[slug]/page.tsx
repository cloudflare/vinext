export default async function Breadcrumbs({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}) {
  const { locale, slug } = await params;
  return (
    <p data-testid="parallel-root-breadcrumb">
      Breadcrumb: {locale}/{slug}
    </p>
  );
}
