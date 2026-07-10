"use client";

import { useSearchParams, useServerInsertedHTML } from "next/navigation";

function InsertedQueryMeta() {
  const searchParams = useSearchParams();
  return <meta name="inserted-query" content={searchParams.get("q") ?? "none"} />;
}

export default function InsertedQueryRegistration() {
  useServerInsertedHTML(() => <InsertedQueryMeta />);
  return <p>Inserted query registered</p>;
}
