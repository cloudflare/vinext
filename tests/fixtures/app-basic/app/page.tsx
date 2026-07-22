import Link from "next/link";

export default function HomePage() {
  return (
    <main>
      <h1>Welcome to App Router</h1>
      <p>This is the home page rendered as a Server Component.</p>
      <nav>
        <Link href="/about">Go to About</Link>
        <Link href="/blog/hello-world">Go to Blog</Link>
        <Link href="/dashboard">Go to Dashboard</Link>
        <Link href="/headers-test" data-testid="headers-test-link">
          Go to Headers Test
        </Link>
        <Link href="/this-route-does-not-exist" prefetch={false} data-testid="missing-route-link">
          Missing Route
        </Link>
        <Link href="/redirect-test-config" data-testid="redirect-test-link">
          Go to Redirect Test
        </Link>
        <Link href="/rewritten-use-pathname" data-testid="config-rewrite-pathname-link">
          Config Rewrite Pathname
        </Link>
        <Link
          href="/rsc-fetch-redirect-src"
          prefetch={false}
          data-testid="rsc-fetch-redirect-src-link"
        >
          RSC Fetch Redirect Source
        </Link>
        <Link href="/nav-flash/link-sync" data-testid="nav-flash-link">
          Nav Flash Test
        </Link>
        <Link href="/nav-flash/list" data-testid="nav-flash-list-link">
          Nav Flash List
        </Link>
        <Link href="/error-test" data-testid="error-test-link">
          Error Test
        </Link>
        <Link href="/delayed-protected-loading" data-testid="delayed-protected-loading-link">
          Delayed Protected Loading
        </Link>
        <Link href="/slow-layout-with-loading/slow" data-testid="slow-layout-with-loading-link">
          Slow Layout With Ancestor Loading
        </Link>
        <Link href="/slow-slot-loading/slow" data-testid="slow-slot-loading-link">
          Slow Named Slot With Loading
        </Link>
        <Link href="/metadata-redirect-test" prefetch={false} data-testid="metadata-redirect-link">
          Metadata Redirect
        </Link>
        <Link
          href="/metadata-streaming-not-found"
          prefetch={false}
          data-testid="metadata-streaming-not-found-link"
        >
          Metadata Not Found
        </Link>
        <Link
          href="/nextjs-compat/metadata-error-with-boundary"
          prefetch={false}
          data-testid="metadata-error-with-boundary-link"
        >
          Metadata Error
        </Link>
      </nav>
    </main>
  );
}
