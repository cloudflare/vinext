import Link from "next/link";

export default function Hello() {
  return (
    <main>
      <h1>Hello</h1>
      <Link href="/about" id="other-page-link">
        About
      </Link>
      <Link href="/slow-route" id="slow-route">
        Slow route
      </Link>
      <Link href="/error-route" id="error-route">
        Error route
      </Link>
      <Link href="/hello#some-hash" id="hash-change">
        Hash change
      </Link>
    </main>
  );
}
