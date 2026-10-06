import { Suspense, type ReactNode } from "react";

// Streams the page after the document head, so its searchParams read turns
// the render dynamic only once the head is out.
async function AfterDelay({ children }: { children: ReactNode }) {
  await new Promise((resolve) => setTimeout(resolve, 300));
  return children;
}

export default function DelayedClientPageLayout({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={<p data-testid="delayed-client-page-fallback">loading</p>}>
      <AfterDelay>{children}</AfterDelay>
    </Suspense>
  );
}
