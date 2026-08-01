import Link from "next/link";

export default function ForceDynamicSource() {
  return (
    <main>
      <h1>Force dynamic source</h1>
      <Link id="cdn-dynamic-prefetch-link" href="/force-dynamic/prefetch">
        Dynamic prefetch
      </Link>
      <Link id="cdn-dynamic-navigation-link" href="/force-dynamic/navigation" prefetch={false}>
        Dynamic navigation
      </Link>
    </main>
  );
}
