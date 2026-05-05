export default function ParallelNestedLayout({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <h1>Parallel Nested Layout</h1>
      <div id="children">{children}</div>
    </div>
  );
}
