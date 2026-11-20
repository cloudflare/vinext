// A source page, an intercepted photo and another page under one layout that
// owns the @modal slot, so each page keeps the slot's layout mounted.
export default function InterceptionTraverseReloadLayout({
  children,
  modal,
}: {
  children: React.ReactNode;
  modal: React.ReactNode;
}) {
  return (
    <div id="interception-traverse-reload-layout">
      {children}
      {modal}
    </div>
  );
}
