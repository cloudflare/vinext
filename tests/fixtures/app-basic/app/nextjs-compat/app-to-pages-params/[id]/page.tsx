import Link from "next/link";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  return (
    <div>
      <h1 id="app-to-pages-params-page">App Params Source</h1>
      <p id="app-param-id">{id}</p>
      <Link href="/search-params-pages/foo" id="go-to-pages-params">
        Go to Pages Params
      </Link>
    </div>
  );
}
