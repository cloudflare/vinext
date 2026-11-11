import Link from "next/link";

// Two items of one category. Only the first is prefetched.
export default function VaryPrefetchLinks() {
  return (
    <main>
      <Link id="link-a" href="/vary-prefetch/shoes/a">
        a
      </Link>
      <Link id="link-b" href="/vary-prefetch/shoes/b" prefetch={false}>
        b
      </Link>
    </main>
  );
}
