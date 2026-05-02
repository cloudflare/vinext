import Link from "next/link";

export default function HomePage() {
  return (
    <main>
      <h1>Static Export — App Router</h1>
      <p>This page is pre-rendered at build time by the App Router.</p>
      <nav>
        <ul>
          <li>
            <Link href="/about">About (App Router)</Link>
          </li>
          <li>
            <Link href="/blog/hello-world">Blog: hello-world</Link>
          </li>
          <li>
            <Link href="/blog/getting-started">Blog: getting-started</Link>
          </li>
          <li>
            <Link href="/old-school">Old-school (Pages Router)</Link>
          </li>
          <li>
            <Link href="/products/widget">Product: widget (Pages Router)</Link>
          </li>
        </ul>
      </nav>
    </main>
  );
}
