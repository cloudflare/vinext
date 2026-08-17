import type { PropsWithChildren } from "react";
import { LayoutState } from "./layout-state";

// `/layout-identity/[slug]` and `/layout-identity/[slug]/child` share this
// layout and resolve the same `[slug]` value, so navigating between them changes
// only the child segment. The layout must stay mounted across that navigation:
// its DOM node keeps its identity and any client state inside it survives.
export default async function LayoutIdentityLayout({
  children,
  params,
}: PropsWithChildren<{ params: Promise<{ slug: string }> }>) {
  const { slug } = await params;

  return (
    <div data-testid="shared-layout">
      <p data-testid="layout-slug">Layout slug: {slug}</p>
      <LayoutState />
      {children}
    </div>
  );
}
