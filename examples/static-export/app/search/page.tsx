import type { Metadata } from "next";
import { Suspense } from "react";
import SearchState from "./search-state";

export const metadata: Metadata = { title: "URL state" };

export default function SearchPage() {
  return (
    <section className="detail-page">
      <p className="kicker">useSearchParams after static hydration</p>
      <h1>The browser owns the query string.</h1>
      <p className="detail-intro">One exported document can respond to URL state without turning into a request-time rendered page.</p>
      <Suspense fallback={<p>Reading the browser URL…</p>}><SearchState /></Suspense>
    </section>
  );
}
