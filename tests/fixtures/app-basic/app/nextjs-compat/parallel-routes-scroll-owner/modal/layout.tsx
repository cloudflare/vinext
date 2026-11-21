import type { ReactNode } from "react";

// Ported from Next.js: test/e2e/app-dir/parallel-routes-scroll-owner
export default function ModalLayout({
  children,
  modal,
}: {
  children: ReactNode;
  modal: ReactNode;
}) {
  return (
    <>
      <header style={{ height: 100, background: "#ddd" }}>Persistent header</header>
      <main>{children}</main>
      <footer id="modal-page-footer" style={{ height: 300, background: "#ddd" }}>
        Persistent footer
      </footer>
      {modal}
    </>
  );
}
