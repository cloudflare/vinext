export default function ActionRevalidateLayout({ children }: { children: React.ReactNode }) {
  return (
    <section>
      <div id="layout-version">{crypto.randomUUID()}</div>
      {children}
    </section>
  );
}
