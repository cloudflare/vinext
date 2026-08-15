import { Suspense } from "react";
import Link from "next/link";
import { QueryValue } from "../search-params/query-value";

export const dynamic = "force-static";

export default function ForceStaticSearchParamsPage() {
  return (
    <main>
      <h1>Force-static search params</h1>
      <Suspense fallback={<p data-testid="query-value">loading</p>}>
        <QueryValue />
      </Suspense>
      <Link href="/search-params?value=restored">Ordinary search params</Link>
    </main>
  );
}
