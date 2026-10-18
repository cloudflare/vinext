import Link from "next/link";
import { RelativeQueryLink } from "./relative-query-link";

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
        <Link href="/this-route-does-not-exist" id="link-to-nonexistent">
          Go to Non-Existent Page
        </Link>
        <Link href="/notfound-test" id="link-to-notfound-page">
          Go to notFound() Page
        </Link>
        <Link href="/nextjs-compat/nav-redirect-server" id="link-to-redirect-page">
          Go to redirect() Page
        </Link>
        <Link href="/nextjs-compat/self-redirect" id="link-to-self-redirect">
          Go to self-redirecting Page
        </Link>
        <Link href="/nextjs-compat/self-redirect-streamed" id="link-to-self-redirect-streamed">
          Go to streamed self-redirecting Page
        </Link>
      </nav>
      <RelativeQueryLink />
    </div>
  );
}
