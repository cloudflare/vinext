"use client";

import "client-only";

// This component imports "client-only" which ensures it is never
// accidentally imported in a Server Component.

export default function ClientOnlyWidget() {
  return <div data-testid="client-only-widget">Client Only Widget (rendered in browser)</div>;
}
