export default function QueryStaleClientLayout({ children }: { children: React.ReactNode }) {
  return (
    <main>
      <output data-testid="query-stale-client-id">{crypto.randomUUID()}</output>
      {children}
    </main>
  );
}
