import Link from "next/link";

// Ported from Next.js: test/e2e/middleware-shallow-link/app/pages/index.js
// https://github.com/vercel/next.js/blob/canary/test/e2e/middleware-shallow-link/app/pages/index.js
//
// Page 1 of the middleware-rewritten shallow-link history-traversal scenario.
// Every route here is matched by the fixture's `middleware.ts` (which runs
// `NextResponse.next()` and stamps `x-custom-middleware`), so the navigations
// below are "middleware-rewritten" in the sense the upstream test exercises.
export default function Page() {
  return (
    <>
      <h1>Content for page 1</h1>
      <div>
        <Link data-next-shallow-push shallow href={{ query: { params: "testParams" } }}>
          Shallow push
        </Link>
      </div>
      <div>
        <Link data-next-page href="/mw-shallow-link-page2">
          Go to page 2
        </Link>
      </div>
    </>
  );
}
