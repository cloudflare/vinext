export default function InheritedSlotLayout({
  children,
  breadcrumbs,
}: {
  children: React.ReactNode;
  breadcrumbs?: React.ReactNode;
}) {
  return (
    <div data-testid="inherited-slot-layout">
      <div>{breadcrumbs}</div>
      <div>{children}</div>
    </div>
  );
}
