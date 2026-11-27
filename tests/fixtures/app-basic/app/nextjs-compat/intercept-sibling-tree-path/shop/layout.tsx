// The shop folder has no page of its own, so the tree path of its sibling
// intercept, /shop, names no route.
export default function InterceptSiblingTreePathShopLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <div id="intercept-sibling-tree-path-shop-layout">{children}</div>;
}
