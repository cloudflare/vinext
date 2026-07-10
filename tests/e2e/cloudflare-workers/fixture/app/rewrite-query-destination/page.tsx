import VisibleRewriteQuery from "./client";

export default async function WorkerRewriteQueryDestination({
  searchParams,
}: {
  searchParams: Promise<{ shown?: string; hidden?: string }>;
}) {
  const query = await searchParams;
  return (
    <main>
      <p data-testid="worker-rewrite-server">
        server:shown={query.shown ?? "none"}&amp;hidden={query.hidden ?? "none"}
      </p>
      <VisibleRewriteQuery />
    </main>
  );
}
