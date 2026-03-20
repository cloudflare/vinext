import React, { Suspense } from "react";

async function AsyncServerThrow(): Promise<React.ReactNode> {
  // Keep the throw async so it happens during Flight streaming.
  await new Promise((resolve) => setTimeout(resolve, 10));
  throw new Error("react19-dev-rsc-error");
}

export default function React19DevRscErrorPage() {
  return (
    <div>
      <h1>React 19 Dev RSC Error Repro</h1>
      <Suspense fallback={<p data-testid="react19-dev-rsc-loading">Loading repro...</p>}>
        <AsyncServerThrow />
      </Suspense>
    </div>
  );
}
