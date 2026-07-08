import Link from "next/link";

// Ported from Next.js: test/e2e/middleware-shallow-link/app/pages/page2.js
// https://github.com/vercel/next.js/blob/canary/test/e2e/middleware-shallow-link/app/pages/page2.js
//
// Page 2 of the middleware-rewritten shallow-link history-traversal scenario.
export default function Page() {
  return (
    <>
      <h1>Content for page 2</h1>
      <Link data-next-shallow-replace replace shallow href={{ query: { params: "testParams" } }}>
        Shallow replace
      </Link>
      <div>
        <button data-go-back onClick={() => window.history.back()}>
          Go Back
        </button>
      </div>
    </>
  );
}
