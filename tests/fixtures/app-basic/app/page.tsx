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
      </nav>
    </main>
  );
}
