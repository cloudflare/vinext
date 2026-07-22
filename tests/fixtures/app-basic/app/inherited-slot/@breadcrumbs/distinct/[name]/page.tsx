export default async function BreadcrumbsDistinctName({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const { name } = await params;
  return <span data-testid="bc">name:{name}</span>;
}
