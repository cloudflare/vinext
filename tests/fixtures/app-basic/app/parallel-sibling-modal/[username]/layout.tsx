export default function ParallelSiblingModalLayout({
  feed,
  modal,
}: {
  feed: React.ReactNode;
  modal: React.ReactNode;
}) {
  return (
    <main data-testid="parallel-sibling-layout">
      <h1>Parallel User</h1>
      {feed}
      {modal}
    </main>
  );
}
