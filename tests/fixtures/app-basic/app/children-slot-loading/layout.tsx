// A parallel slot with its own sub-paths gives the children pages here an
// implicit children slot. sub/loading.tsx wraps the shared `x` segment of
// sub/x/a and sub/x/b, and among the sub/x pages the panel slot matches only
// sub/x/b.
export default function ChildrenSlotLoadingLayout({
  children,
  panel,
}: {
  children: React.ReactNode;
  panel: React.ReactNode;
}) {
  return (
    <section>
      {children}
      {panel}
    </section>
  );
}
