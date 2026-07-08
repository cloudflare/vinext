import Link from "next/link";

export default async function LocalePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  return (
    <div>
      <Link href={`/interception-from-root/${locale}/example`} id="go-to-example">
        Go to example
      </Link>
    </div>
  );
}
