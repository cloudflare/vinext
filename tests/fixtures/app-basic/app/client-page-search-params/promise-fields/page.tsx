"use client";

// Reads React's promise fields off searchParams directly. `status` and `value`
// are reserved, so this page's query doesn't shadow them, and neither the SSR
// nor the browser promise carries them before React tracks it.
export default function ClientPagePromiseFieldsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const status = String(Reflect.get(searchParams, "status"));
  const value = String(Reflect.get(searchParams, "value"));

  return <p data-testid="client-page-promise-fields">{`status:${status} value:${value}`}</p>;
}
