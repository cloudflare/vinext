import Link from "next/link";

export default function Page() {
  return (
    <div>
      <h1 id="link-test-page">Link Test Page</h1>
      <nav>
        <Link href="/nextjs-compat/nav-redirect-result" id="link-to-result">
          Go to Result
        </Link>
        <Link href="/nextjs-compat/metadata-title" id="link-to-title">
          Go to Title Page
        </Link>
        <Link href="/" id="link-to-home">
          Go Home
        </Link>
      </nav>
    </div>
  );
}
