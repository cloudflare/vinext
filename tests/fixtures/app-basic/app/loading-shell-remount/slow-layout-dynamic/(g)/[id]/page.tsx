export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ q?: string }>;
}) {
  const { id } = await params;
  const { q } = await searchParams;
  return <h1 id="page-heading">{`slow-layout-dynamic ${id}${q ? `?q=${q}` : ""}`}</h1>;
}
