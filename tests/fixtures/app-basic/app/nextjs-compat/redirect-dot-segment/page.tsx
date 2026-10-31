import Link from "next/link";

export default function RedirectDotSegmentHome() {
  return (
    <main>
      <h1 id="redirect-dot-segment-home">Redirect dot segment home</h1>
      <Link
        href="/nextjs-compat/redirect-dot-segment/layout-redirect"
        prefetch={false}
        id="redirect-dot-segment-layout-redirect"
      >
        To a page whose layout redirects to a path that starts with /.//
      </Link>
    </main>
  );
}
