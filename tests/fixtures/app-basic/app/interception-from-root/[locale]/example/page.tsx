import Link from "next/link";

export default async function ExamplePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  return (
    <div>
      <h1>Example Page</h1>
      <Link href={`/interception-from-root/${locale}/intercepted`} id="intercept-link">
        Intercept /{locale}/intercepted
      </Link>
    </div>
  );
}
