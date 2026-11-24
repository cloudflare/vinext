import { Suspense } from "react";
import { cookies } from "next/headers";

export const dynamic = "force-dynamic";

// Resumes after the client has cancelled the HTML document (issue #4789).
async function DelayedCookieReader() {
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const store = await cookies();
  return <p id="cookie-count">{store.getAll().length}</p>;
}

export default function CancelledDocumentCookiesPage() {
  return (
    <main>
      <h1 id="shell">Cancelled document cookies</h1>
      <Suspense fallback={<p id="fallback">Loading...</p>}>
        <DelayedCookieReader />
      </Suspense>
    </main>
  );
}
