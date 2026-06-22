export const revalidate = 900;

export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  return <span id="generated-at">generated-{lang}</span>;
}
