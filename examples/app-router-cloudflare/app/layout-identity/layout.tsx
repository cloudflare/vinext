import type { ReactNode } from "react";

// A parallel slot sits beside `children`, above the shared `[slug]` layout —
// the shape an app has when route-derived chrome (breadcrumbs, a sidebar) is
// rendered as a slot. The slot's content changes on every navigation while the
// `[slug]` layout below stays on the same segment value.
export default function LayoutIdentityRootLayout({
  children,
  aside,
}: {
  children: ReactNode;
  aside: ReactNode;
}) {
  return (
    <div>
      <div data-testid="aside-slot">{aside}</div>
      {children}
    </div>
  );
}
