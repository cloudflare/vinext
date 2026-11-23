// The feed changes after the build: the export holds "old", while the
// deployed Worker's generator now lists "new".
export function generateStaticParams() {
  return [{ id: process.env.NEXT_PHASE === "phase-production-build" ? "old" : "new" }];
}

export default async function FeedItem({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <h1>Feed {id}</h1>;
}
