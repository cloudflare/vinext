import Link from "next/link";

// Ported from Next.js:
// test/e2e/repeated-forward-slashes-error/repeated-forward-slashes-error.test.ts
// (a Pages Router test). The dynamic route pattern `/my/path/[name]` must
// appear in the "Invalid href ... in page: '...'" console.error emitted when
// a <Link> href contains repeated forward-slashes.
export default function RepeatedSlashesLinkPage() {
  return (
    <main data-testid="repeated-slashes-link-page">
      <Link href="/hello//world" id="repeated-slash-link">
        Hello
      </Link>
    </main>
  );
}
