import Link from "next/link";

/**
 * Test fixture: a layout owning the @modal slot, whose intercepting pages have
 * metadata files in their own folders, in a route group above the marker and
 * at the slot's root. `/first` renders only in the slot, so no page comes
 * before it on Next.js's head walk and an intercept heads the route.
 */
export default function Layout({
  children,
  modal,
}: {
  children: React.ReactNode;
  modal: React.ReactNode;
}) {
  return (
    <div id="intercept-metadata-files-layout">
      <Link href="/nextjs-compat/intercept-metadata-files/photo/1">Photo 1</Link>
      <Link href="/nextjs-compat/intercept-metadata-files/shot/2">Shot 2</Link>
      {children}
      <div id="intercept-metadata-files-modal">{modal}</div>
    </div>
  );
}
