"use client";

import { ReadonlyURLSearchParams, useSearchParams } from "next/navigation";
import { useSyncExternalStore } from "react";

function describeMutationAttempt(searchParams: URLSearchParams) {
  const before = searchParams.toString();

  try {
    searchParams.set("attempted", "1");
    return {
      status: "FAIL mutation succeeded",
      message: "",
      before,
      after: searchParams.toString(),
    };
  } catch (error) {
    return {
      status: "PASS mutation blocked",
      message: error instanceof Error ? error.message : String(error),
      before,
      after: searchParams.toString(),
    };
  }
}

// Ported from Next.js: test/e2e/app-dir/hooks/app/hooks/use-search-params/instanceof/page.js
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/hooks/app/hooks/use-search-params/instanceof/page.js
export default function Page() {
  const searchParams = useSearchParams();
  const searchParamsClient = useSyncExternalStore(
    () => {
      return () => {};
    },
    () => searchParams,
    () => null,
  );

  const serverMutation = describeMutationAttempt(searchParams);
  const clientMutation =
    searchParamsClient === null ? null : describeMutationAttempt(searchParamsClient);

  return (
    <div>
      <h1 id="readonly-search-params-page">Readonly Search Params Test</h1>
      <p data-testid="server-instance" suppressHydrationWarning>
        {searchParams instanceof ReadonlyURLSearchParams
          ? "PASS instanceof check"
          : `FAIL instanceof ${searchParams.constructor.name}`}
      </p>
      <p data-testid="server-mutation-status" suppressHydrationWarning>
        {serverMutation.status}
      </p>
      <p data-testid="server-mutation-message" suppressHydrationWarning>
        {serverMutation.message}
      </p>
      <p data-testid="server-before" suppressHydrationWarning>
        {serverMutation.before}
      </p>
      <p data-testid="server-after" suppressHydrationWarning>
        {serverMutation.after}
      </p>

      <p data-testid="client-instance">
        {searchParamsClient === null
          ? "<pending>"
          : searchParamsClient instanceof ReadonlyURLSearchParams
            ? "PASS instanceof check"
            : `FAIL instanceof ${searchParamsClient.constructor.name}`}
      </p>
      <p data-testid="client-mutation-status">
        {clientMutation === null ? "<pending>" : clientMutation.status}
      </p>
      <p data-testid="client-mutation-message">
        {clientMutation === null ? "<pending>" : clientMutation.message}
      </p>
      <p data-testid="client-before">
        {clientMutation === null ? "<pending>" : clientMutation.before}
      </p>
      <p data-testid="client-after">
        {clientMutation === null ? "<pending>" : clientMutation.after}
      </p>
    </div>
  );
}
