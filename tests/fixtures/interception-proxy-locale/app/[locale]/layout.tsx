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
        <div id="children">{children}</div>
        <div id="modal">{modal}</div>
      </body>
    </html>
  );
}
