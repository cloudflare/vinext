import Link from "next/link";

export default async function ProviderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <div>
      <h1 id="provider-title">Provider {id}</h1>
      <Link href="/nav-flash/provider/1" id="link-p1">
        Provider 1
      </Link>
      <Link href="/nav-flash/provider/2" id="link-p2">
        Provider 2
      </Link>
      <Link href="/nav-flash/list" id="link-list">
        Back to List
      </Link>
    </div>
  );
}
