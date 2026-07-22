// Pages Router fixture that uses `next/navigation` hooks.
// Mirrors the Next.js test in:
// .nextjs-ref/test/e2e/app-dir/params-hooks-compat/shared/params-component.js
//
// Under Pages Router, useParams() must return ONLY the dynamic route params
// (no query-string keys) and useSearchParams() must return ONLY the query
// string (no route param keys). See `adaptForSearchParams` and
// `adaptForPathParams` in Next.js:
// https://github.com/vercel/next.js/blob/canary/packages/next/src/shared/lib/router/adapters.tsx
import { useParams, useSearchParams } from "next/navigation";

export default function PagesNavCompat() {
  const params = useParams();
  const searchParams = useSearchParams();
  const searchObject = Object.fromEntries(searchParams ? searchParams.entries() : []);
  return (
    <div>
      <h2>useParams()</h2>
      <pre id="use-params">{JSON.stringify(params)}</pre>
      <h2>useSearchParams()</h2>
      <pre id="use-search-params">{JSON.stringify(searchObject)}</pre>
    </div>
  );
}
