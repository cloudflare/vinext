import Link from "next/link";

const BASE = "/notfound-sibling-slots";

/**
 * Test fixture: a layout with named parallel slots whose page or child layout
 * calls notFound(), forbidden() or unauthorized(). Next.js wraps only the
 * segment's `children` in its access boundaries, so the @sidebar slot keeps
 * rendering beside the boundary that catches the signal.
 */
export default function Layout({
  children,
  sidebar,
  modal,
}: {
  children: React.ReactNode;
  sidebar: React.ReactNode;
  modal: React.ReactNode;
}) {
  return (
    <div id="notfound-sibling-slots-layout">
      <nav>
        <Link href={BASE}>Home</Link>
        <Link href={`${BASE}/missing`}>Missing</Link>
        <Link href={`${BASE}/denied`}>Denied</Link>
        <Link href={`${BASE}/unauth`}>Unauth</Link>
        <Link href={`${BASE}/sub`}>Sub</Link>
      </nav>
      <main id="notfound-sibling-slots-children">{children}</main>
      {sidebar}
      {modal}
    </div>
  );
}
