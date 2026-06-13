export default function Layout({
  children,
  modal,
}: {
  children: React.ReactNode;
  modal: React.ReactNode;
}) {
  return (
    <html>
      <body>
        <div id="children">
          <div>CHILDREN SLOT:</div>
          {children}
        </div>
        <div id="modal">
          <div>MODAL SLOT:</div>
          {modal}
        </div>
      </body>
    </html>
  );
}
