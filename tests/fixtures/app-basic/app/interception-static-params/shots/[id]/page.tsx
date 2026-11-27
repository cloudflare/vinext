import Link from "next/link";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <nav>
      <p data-testid="shot-page">Shot page: {id}</p>
      <Link href="/interception-static-params/shots/2">Shot 2</Link>
      <Link href="/interception-static-params/shots/3">Shot 3</Link>
    </nav>
  );
}
