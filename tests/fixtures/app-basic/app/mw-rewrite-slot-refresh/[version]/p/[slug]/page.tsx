import { RefreshButton } from "./refresh-button";

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return (
    <>
      <p id="mw-rewrite-slot-refresh-page">page {slug}</p>
      <RefreshButton />
    </>
  );
}
