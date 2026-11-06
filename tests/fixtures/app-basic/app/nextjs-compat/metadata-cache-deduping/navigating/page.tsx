import Link from "next/link";

// Ported from Next.js: test/e2e/app-dir/metadata/app/cache-deduping/navigating/page.tsx
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/metadata/app/cache-deduping/navigating/page.tsx
export default function Page() {
  return (
    <Link href="/nextjs-compat/metadata-cache-deduping" id="link-to-deduping-page">
      To cache deduping page
    </Link>
  );
}
