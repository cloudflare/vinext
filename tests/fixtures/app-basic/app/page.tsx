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
      </nav>
    </main>
  );
}
