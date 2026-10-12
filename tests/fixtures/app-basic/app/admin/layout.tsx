// Neutral layout: the protected content lives only in page.tsx, so an
// interception source that falls back to this slot owner must not render it.
export default function AdminLayout({
  children,
  modal,
}: {
  children: React.ReactNode;
  modal?: React.ReactNode;
}) {
  return (
    <div data-testid="admin-layout">
      {children}
      {modal}
    </div>
  );
}
