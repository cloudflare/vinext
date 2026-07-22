import { Suspense } from "react";

export default function Layout({
  children,
  modal,
}: {
  children: React.ReactNode;
  modal: React.ReactNode;
}) {
  return (
    <Suspense>
      <html>
        <body>
          <div id="children">{children}</div>
          <div id="modal">{modal}</div>
        </body>
      </html>
    </Suspense>
  );
}
