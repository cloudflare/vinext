export default function TipsLayout({
  children,
  modal,
}: {
  children: React.ReactNode;
  modal: React.ReactNode;
}) {
  return (
    <div>
      <div id="children">{children}</div>
      <div id="modal">{modal}</div>
    </div>
  );
}
