"use client";

import Link from "next/link";

export default function DocsCollisionError({ error }: { error: Error; reset: () => void }) {
  return (
    <section data-testid="docs-error-boundary">
      <h1>Docs error boundary</h1>
      <p>{error.message}</p>
      <Link data-testid="to-docs-guide-b" href="/reset-collision/docs/guide/b">
        Go to docs guide b
      </Link>
    </section>
  );
}
