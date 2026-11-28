export default async function Page({ params }: { params: Promise<{ id: string; lang: string }> }) {
  const { id, lang } = await params;
  return <p id="localized-rewrite">{lang + ":" + id}</p>;
}
