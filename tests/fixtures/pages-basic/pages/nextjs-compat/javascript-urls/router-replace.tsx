// Ported from Next.js: test/e2e/app-dir/javascript-urls/pages/pages/router-replace.tsx
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/javascript-urls/pages/pages/router-replace.tsx
import Link from "next/link";
import { useRouter } from "next/router";

import { DANGEROUS_JAVASCRIPT_URL } from "./bad-url";

export default function Page() {
  const router = useRouter();
  return (
    <div>
      <main>
        <p>Clicking this button should result in an error where Next.js blocks a javascript URL</p>
        <button onClick={() => router.replace(DANGEROUS_JAVASCRIPT_URL)}>
          replace javascript URL
        </button>
      </main>
      <footer>
        <Link href="/nextjs-compat/javascript-urls/safe">Safe Page</Link>
      </footer>
    </div>
  );
}
