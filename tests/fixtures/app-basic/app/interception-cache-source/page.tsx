import Link from "next/link";

export const revalidate = 1;

export default function InterceptionCacheSourcePage() {
  return (
    <section data-testid="interception-cache-source-page">
      <h1>Interception cache source</h1>
      <Link href="/interception-cache-target/malformed">Malformed context target</Link>
      <Link href="/interception-cache-target/html" id="interception-cache-html-link">
        HTML context target
      </Link>
      <Link href="/interception-cache-target/html-browser" id="interception-cache-browser-link">
        Browser interception cache target
      </Link>
    </section>
  );
}
