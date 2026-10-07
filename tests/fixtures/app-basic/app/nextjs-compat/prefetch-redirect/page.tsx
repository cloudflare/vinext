import Link from "next/link";

export default function PrefetchRedirectHome() {
  return (
    <main>
      <h1 id="prefetch-redirect-home">Prefetch redirect home</h1>
      <Link href="/nextjs-compat/prefetch-redirect/static" id="prefetch-redirect-static">
        To a static page that redirects
      </Link>
      <Link
        href="/nextjs-compat/prefetch-redirect/dynamic"
        prefetch={true}
        id="prefetch-redirect-dynamic"
      >
        To a dynamic page that redirects
      </Link>
      <Link
        href="/nextjs-compat/prefetch-redirect/dynamic-auto"
        id="prefetch-redirect-dynamic-auto"
      >
        To a dynamic page that redirects, auto prefetch
      </Link>
      <Link
        href="/nextjs-compat/prefetch-redirect/layout-guard"
        id="prefetch-redirect-layout-guard"
      >
        To a page whose layout reads cookies and redirects
      </Link>
    </main>
  );
}
