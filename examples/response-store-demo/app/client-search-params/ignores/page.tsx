"use client";

// A client page that never reads its searchParams prop. Its RSC payload
// carries no query, so one stored page serves every query, as in Next.js.
export default function ClientSearchParamsIgnoresPage() {
  return (
    <>
      <h1>
        <code>/client-search-params/ignores</code>
      </h1>
      <p>This client page doesn&apos;t read searchParams, so it stays static.</p>
    </>
  );
}
