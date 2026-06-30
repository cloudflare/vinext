export default function Layout({
  children,
  slot,
}: {
  children: React.ReactNode;
  slot: React.ReactNode;
}) {
  return (
    <main>
      <div data-testid="parallel-slot-default-children">{children}</div>
      <div data-testid="parallel-slot-default-slot">{slot}</div>
    </main>
  );
}
