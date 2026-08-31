import type { PropsWithChildren } from "react";

// A second nested layout beneath the shared `[slug]` layout, owning its own
// dynamic segment, so the navigation crosses two layout levels at once.
export default async function ItemLayout({
  children,
  params,
}: PropsWithChildren<{ params: Promise<{ item: string }> }>) {
  const { item } = await params;

  return (
    <div data-testid="item-layout">
      <p data-testid="item-layout-value">Item layout: {item}</p>
      {children}
    </div>
  );
}
