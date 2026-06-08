// Ported from Next.js: test/e2e/app-dir/javascript-urls/pages/pages/link-as.tsx
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/javascript-urls/pages/pages/link-as.tsx
import Link from "next/link";

import { DANGEROUS_JAVASCRIPT_URL } from "./bad-url";

export default function Page() {
  return (
    <div>
      <main>
        <p>Clicking this link should result in an error where Next.js blocks a javascript URL</p>
        <Link href="/" as={DANGEROUS_JAVASCRIPT_URL}>
          Link with javascript URL `as`
        </Link>
      </main>
      <footer>
        <Link href="/nextjs-compat/javascript-urls/safe">Safe Page</Link>
      </footer>
    </div>
  );
}
