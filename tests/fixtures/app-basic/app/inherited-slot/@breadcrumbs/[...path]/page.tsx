export default async function BreadcrumbsCatchAll({
  params,
}: {
  params: Promise<{ path: string[] }>;
}) {
  const { path } = await params;
  return <span data-testid="bc">crumbs:{path.join("/")}</span>;
}
