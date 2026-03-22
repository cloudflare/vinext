import Link from "next/link";

export default async function ProviderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  return (
    <main>
      <h1 id="provider-title">Provider: {id}</h1>
      <p id="provider-copy">Provider detail view</p>
      <Link href="/nav-flash/list" id="back-to-providers">
        Back to providers
      </Link>
    </main>
  );
}
