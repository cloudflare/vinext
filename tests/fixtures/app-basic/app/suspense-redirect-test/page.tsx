import React, { Suspense } from "react";
import { redirect } from "next/navigation";

// Async component that redirects inside a Suspense boundary.
// The redirect() call happens during streaming (after headers are sent),
// so the framework must communicate this via the streamed content
// rather than HTTP status codes.
async function AsyncRedirectComponent(): Promise<React.ReactNode> {
  // Simulate an async operation before redirecting
  await new Promise((resolve) => setTimeout(resolve, 10));
  redirect("/about");
}

export default function SuspenseRedirectTestPage() {
  return (
    <div>
      <h1>Suspense Redirect Test</h1>
      <Suspense fallback={<div>Loading...</div>}>
        <AsyncRedirectComponent />
      </Suspense>
    </div>
  );
}
