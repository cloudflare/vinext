import VisibleRewriteQuery from "./client";

export default async function RewriteQueryDestination({
  searchParams,
}: {
  searchParams: Promise<{ shown?: string; hidden?: string }>;
}) {
  const query = await searchParams;
  return (
    <main>
      <p data-testid="rewrite-page-query">
        server:shown={query.shown ?? "none"}&amp;hidden={query.hidden ?? "none"}
      </p>
      <VisibleRewriteQuery />
    </main>
  );
}
