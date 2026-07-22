export default async function InterceptedFullPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  return (
    <div>
      <h2>Full intercepted page for locale {locale}</h2>
    </div>
  );
}
