"use client";

import { useSelectedLayoutSegment } from "next/navigation";

export default function Layout({
  children,
  modal,
}: {
  children: React.ReactNode;
  modal: React.ReactNode;
}) {
  const modalSegment = useSelectedLayoutSegment("modal");

  return (
    <html>
      <body>
        <div id="children">
          <div>CHILDREN SLOT:</div>
          {children}
        </div>
        <div id="modal">
          <div>MODAL SLOT:</div>
          <div id="modal-segment">modal segment: {modalSegment}</div>
          {modal}
        </div>
      </body>
    </html>
  );
}
