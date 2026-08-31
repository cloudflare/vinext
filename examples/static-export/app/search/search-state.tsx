"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";

export default function SearchState() {
  const searchParams = useSearchParams();
  const topic = searchParams.get("topic") ?? "nothing yet";

  return (
    <div className="query-card">
      <span>Current topic</span>
      <strong data-testid="query-topic">{topic}</strong>
      <div>
        <Link href="/search?topic=constellations">constellations</Link>
        <Link href="/search?topic=tides">tides</Link>
        <Link href="/search?topic=trails">trails</Link>
      </div>
    </div>
  );
}
