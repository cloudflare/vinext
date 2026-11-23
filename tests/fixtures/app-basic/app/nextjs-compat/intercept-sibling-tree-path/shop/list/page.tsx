import Link from "next/link";

export default function InterceptSiblingTreePathListPage() {
  return (
    <div id="intercept-sibling-tree-path-list">
      <Link
        href="/nextjs-compat/intercept-sibling-tree-path/shop/item/1"
        id="intercept-sibling-tree-path-item-1-link"
      >
        Item 1
      </Link>
    </div>
  );
}
