import Link from "next/link";

export default async function InterceptedPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  return (
    <div>
      <h2>Page intercepted from root</h2>
      <Link href={`/interception-from-root/${locale}/example`} id="back-link">
        Back to example
      </Link>
    </div>
  );
}
