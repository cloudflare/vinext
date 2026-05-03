export default async function InheritedSlotCatchAllPage({
  params,
}: {
  params: Promise<{ path: string[] }>;
}) {
  const { path } = await params;
  return <span data-testid="page">path:{path.join("/")}</span>;
}
