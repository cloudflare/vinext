/**
 * Test fixture: (.)item intercepts item/[id] in place of this segment's page
 * on a client navigation. The intercepting page's notFound(), forbidden() and
 * unauthorized() must render the files beside it, inside the (.)item layout,
 * not this segment's.
 */
import Link from "next/link";

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div id="not-found-sibling-intercept-layout">
      <nav>
        <Link href="/nextjs-compat/not-found-sibling-intercept/item/missing">Missing item</Link>
        <Link href="/nextjs-compat/not-found-sibling-intercept/item/metadata-missing">
          Metadata not found
        </Link>
        <Link href="/nextjs-compat/not-found-sibling-intercept/item/forbidden">Forbidden item</Link>
        <Link href="/nextjs-compat/not-found-sibling-intercept/item/unauthorized">
          Unauthorized item
        </Link>
        <Link href="/nextjs-compat/not-found-sibling-intercept/item/1">Item 1</Link>
      </nav>
      {children}
    </div>
  );
}
