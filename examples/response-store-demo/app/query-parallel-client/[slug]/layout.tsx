export default function QueryParallelClientLayout({
  children,
  sidebar,
}: {
  children: React.ReactNode;
  sidebar: React.ReactNode;
}) {
  return (
    <main>
      {children}
      {sidebar}
    </main>
  );
}
