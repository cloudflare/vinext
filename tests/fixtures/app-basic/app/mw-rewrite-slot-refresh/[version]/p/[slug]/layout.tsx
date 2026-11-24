export default function Layout({
  children,
  info,
}: {
  children: React.ReactNode;
  info: React.ReactNode;
}) {
  return (
    <>
      <div id="children">{children}</div>
      <div id="info">{info}</div>
    </>
  );
}
