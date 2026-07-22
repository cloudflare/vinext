export default function ParallelLeafDefaultLayout({
  children,
  slot,
}: {
  children: React.ReactNode;
  slot: React.ReactNode;
}) {
  return (
    <>
      <div data-testid="parallel-leaf-slot">{slot}</div>
      <div data-testid="parallel-leaf-children">{children}</div>
    </>
  );
}
