"use client";

import { use } from "react";

// use() makes React write its bookkeeping onto this page's promise.
export default function PromiseFieldsSiblingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { q } = use(searchParams);

  return <p data-testid="promise-fields-sibling-q">{typeof q === "string" ? q : "(none)"}</p>;
}
