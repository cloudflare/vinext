export default function Layout({
  children,
  slot,
}: {
  children: React.ReactNode;
  slot: React.ReactNode;
}) {
  return (
    <section data-testid="parallel-route-group-depth-layout">
      <div data-testid="parallel-route-group-depth-slot">{slot}</div>
      <div data-testid="parallel-route-group-depth-children">{children}</div>
    </section>
  );
}
