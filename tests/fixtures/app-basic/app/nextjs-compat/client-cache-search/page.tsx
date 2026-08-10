import Link from "next/link";

export default function ClientCacheSearchHome() {
  return (
    <main>
      <h1 id="client-cache-search-home">Client cache search home</h1>
      <Link href="/nextjs-compat/client-cache-search/0?timeout=0" prefetch={true}>
        Full prefetch with search params
      </Link>
      <Link href="/nextjs-compat/client-cache-search/0?timeout=1000" prefetch={true}>
        Slow full prefetch with search params
      </Link>
    </main>
  );
}
