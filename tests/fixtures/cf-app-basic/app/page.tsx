import Link from "next/link";

export default function Home() {
  return (
    <main>
      <h1>Home</h1>
      <Link id="cdn-prefetch-link" href="/about">
        About
      </Link>
      <Link id="cdn-navigation-link" href="/blog/hello-world" prefetch={false}>
        Blog
      </Link>
      <Link id="cdn-loading-prefetch-link" href="/blog/getting-started">
        Blog with loading boundary
      </Link>
    </main>
  );
}
