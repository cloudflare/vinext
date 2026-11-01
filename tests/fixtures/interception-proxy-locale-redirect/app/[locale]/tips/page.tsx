import Link from "next/link";

// The source sits below `[locale]`, so its public pathname `/tips` does not
// match the source pattern `/[locale]/tips` and the client sends its matched
// pathname `/ja/tips`, which middleware redirects back to `/tips`.
export default async function Page({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  return (
    <>
      <p>{`TIPS-SOURCE locale=${locale};`}</p>
      <Link href="/tips/a">tip a</Link>
    </>
  );
}
