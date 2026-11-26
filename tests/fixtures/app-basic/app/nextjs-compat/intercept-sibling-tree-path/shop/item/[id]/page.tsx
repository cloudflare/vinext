export default async function InterceptSiblingTreePathItemPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <div id="intercept-sibling-tree-path-item-page">Item page {id}</div>;
}
