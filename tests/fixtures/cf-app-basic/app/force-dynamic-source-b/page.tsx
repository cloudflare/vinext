import Link from "next/link";

export default function ForceDynamicSourceB() {
  return (
    <main>
      <h1>Force dynamic source B</h1>
      <Link id="cdn-dynamic-prefetch-link" href="/force-dynamic/prefetch">
        Dynamic prefetch
      </Link>
    </main>
  );
}
