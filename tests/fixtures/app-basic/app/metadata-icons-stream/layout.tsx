export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <link rel="icon" href="/manual-layout-icon.png" data-testid="manual-layout-icon" />
      {children}
    </>
  );
}
