"use client";

import { useSelectedLayoutSegment, useSelectedLayoutSegments } from "next/navigation";

export default function Layout({
  children,
  modal,
}: {
  children: React.ReactNode;
  modal: React.ReactNode;
}) {
  const modalSegment = useSelectedLayoutSegment("modal");
  const modalSegments = useSelectedLayoutSegments("modal");

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
          <div id="modal-segments">modal segments: {modalSegments.join("|")}</div>
          {modal}
        </div>
      </body>
    </html>
  );
}
