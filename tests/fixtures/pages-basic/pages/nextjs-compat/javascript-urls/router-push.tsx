// Ported from Next.js: test/e2e/app-dir/javascript-urls/pages/pages/router-push.tsx
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/javascript-urls/pages/pages/router-push.tsx
import Link from "next/link";
import { useRouter } from "next/router";

import { DANGEROUS_JAVASCRIPT_URL } from "./bad-url";

export default function Page() {
  const router = useRouter();
  return (
    <div>
      <main>
        <p>Clicking this button should result in an error where Next.js blocks a javascript URL</p>
        <button onClick={() => router.push(DANGEROUS_JAVASCRIPT_URL)}>push javascript URL</button>
      </main>
      <footer>
        <Link href="/nextjs-compat/javascript-urls/safe">Safe Page</Link>
      </footer>
    </div>
  );
}
