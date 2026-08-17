export default function Layout({
  children,
  aux,
}: {
  children: React.ReactNode;
  aux: React.ReactNode;
}) {
  return (
    <>
      {children}
      {aux}
    </>
  );
}
