import Link from "next/link";

export default async function InterceptSiblingTreePathInterceptedItem({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <div id="intercept-sibling-tree-path-intercepted-item">
      <p>Intercepted item {id}</p>
      <Link
        href={`/nextjs-compat/intercept-sibling-tree-path/shop/item/${Number(id) + 1}`}
        id="intercept-sibling-tree-path-next-item-link"
      >
        Next item
      </Link>
    </div>
  );
}
