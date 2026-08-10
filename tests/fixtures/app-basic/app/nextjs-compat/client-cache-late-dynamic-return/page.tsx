import Link from "next/link";

export default function ClientCacheLateDynamicReturn() {
  return (
    <main>
      <h1 id="client-cache-home">Client cache return page</h1>
      <Link
        href="/nextjs-compat/client-cache-late-dynamic"
        prefetch={false}
        id="client-cache-late-dynamic"
      >
        Return to the late-dynamic page without prefetching it again
      </Link>
    </main>
  );
}
