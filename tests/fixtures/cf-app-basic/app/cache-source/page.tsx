import Link from "next/link";

export default function CacheSource() {
  return (
    <main>
      <h1>Cache source</h1>
      <Link id="cdn-prefetch-link" href="/about">
        About
      </Link>
    </main>
  );
}
