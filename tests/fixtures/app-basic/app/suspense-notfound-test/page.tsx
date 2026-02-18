import React, { Suspense } from "react";
import { notFound } from "next/navigation";

// Async component that calls notFound() inside a Suspense boundary.
// The notFound() call happens during streaming (after headers are sent),
// so the framework must handle this gracefully rather than silently failing.
async function AsyncNotFoundComponent(): Promise<React.ReactNode> {
  // Simulate an async operation before triggering not found
  await new Promise((resolve) => setTimeout(resolve, 10));
  notFound();
}

export default function SuspenseNotFoundTestPage() {
  return (
    <div>
      <h1>Suspense Not Found Test</h1>
      <Suspense fallback={<div>Loading...</div>}>
        <AsyncNotFoundComponent />
      </Suspense>
    </div>
  );
}
