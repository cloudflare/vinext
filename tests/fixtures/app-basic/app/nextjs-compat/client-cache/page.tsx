import Link from "next/link";

export default function ClientCacheHome() {
  return (
    <main>
      <h1 id="client-cache-home">Client cache home</h1>
      <Link href="/nextjs-compat/client-cache/0" prefetch={true} id="client-cache-full">
        Full prefetch
      </Link>
    </main>
  );
}
