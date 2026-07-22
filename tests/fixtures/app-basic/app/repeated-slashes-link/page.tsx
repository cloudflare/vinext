import Link from "next/link";

// Ported from Next.js:
// test/e2e/repeated-forward-slashes-error/repeated-forward-slashes-error.test.ts
// Rendering a <Link> whose href has repeated forward-slashes must emit
// Next.js's "Invalid href" console.error during SSR.
export default function RepeatedSlashesLinkPage() {
  return (
    <main data-testid="repeated-slashes-link-page">
      <Link href="/hello//world" id="repeated-slash-link">
        Hello
      </Link>
    </main>
  );
}
