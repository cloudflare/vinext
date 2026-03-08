export default async function Page({
  params,
}: {
  params: Promise<{ lang: string }>;
}) {
  const { lang } = await params;
  return <p id="not-found-params-layout-page">Page for lang: {lang}</p>;
}
