import Link from "next/link";

export default async function Page({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  return (
    <>
      <p data-testid="parallel-root-locale">Locale: {locale}</p>
      <Link href="/parallel-root-param/es/no-gsp/stories/dynamic-123">Dynamic child</Link>
      <Link href="/parallel-root-param/en/gsp/stories/dynamic-123">Unknown static child</Link>
    </>
  );
}
