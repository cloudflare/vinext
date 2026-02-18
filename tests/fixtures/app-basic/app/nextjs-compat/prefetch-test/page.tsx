import Link from "next/link";

export default function PrefetchPage() {
  return (
    <div>
      <h1 id="prefetch-home">Prefetch Test Home</h1>
      <Link href="/nextjs-compat/prefetch-test/target" id="prefetch-link">
        Go to target
      </Link>
      <Link href="/nextjs-compat/prefetch-test/no-prefetch" id="no-prefetch-link" prefetch={false}>
        Go to no-prefetch target
      </Link>
    </div>
  );
}
