import Link from "next/link";

// Ported from Next.js:
// test/e2e/app-dir/router-disable-smooth-scroll/fixtures/optimized/app/page1/page.tsx
export default function SmoothScrollPage1() {
  return (
    <div>
      <h1 id="smooth-scroll-page">Page 1</h1>
      <Link href="/nextjs-compat/router-disable-smooth-scroll/page2" id="to-page2">
        Go to Page 2
      </Link>
      <div style={{ height: 3000 }} />
      <p>Bottom of page 1</p>
    </div>
  );
}
