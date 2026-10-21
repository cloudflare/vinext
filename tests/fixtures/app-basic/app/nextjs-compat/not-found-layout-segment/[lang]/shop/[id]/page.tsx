export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <p id="not-found-layout-segment-page">Item: {id}</p>;
}
