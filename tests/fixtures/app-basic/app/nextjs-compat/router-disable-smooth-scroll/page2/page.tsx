import Link from "next/link";

// Ported from Next.js:
// test/e2e/app-dir/router-disable-smooth-scroll/fixtures/optimized/app/page2/page.tsx
export default function SmoothScrollPage2() {
  return (
    <div>
      <h1 id="smooth-scroll-page">Page 2</h1>
      <Link href="/nextjs-compat/router-disable-smooth-scroll/page1" id="to-page1">
        Go to Page 1
      </Link>
      <div style={{ height: 3000 }} />
      <p>Bottom of page 2</p>
    </div>
  );
}
