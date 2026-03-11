import Link from "next/link";

export default function Home() {
  return (
    <div>
      <h1>Asset Prefix Test</h1>
      <p>This page verifies that static assets are served from the CDN prefix.</p>
      <Link href="/about">Go to About</Link>
    </div>
  );
}
