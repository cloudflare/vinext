"use client";

// Reads React's promise fields directly. Its promise is its own, so the
// sibling page's use() never shows here, in SSR or the browser.
export default function PromiseFieldsSiblingFieldsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const status = String(Reflect.get(searchParams, "status"));
  const value = String(Reflect.get(searchParams, "value"));

  return <p data-testid="promise-fields-sibling-fields">{`status:${status} value:${value}`}</p>;
}
