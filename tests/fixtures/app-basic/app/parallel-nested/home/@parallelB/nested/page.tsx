export default function ParallelBNestedPage() {
  return (
    <>
      <p data-testid="parallelB-nested-page">Hello from nested parallel page!</p>
      <div id="timestamp">{Date.now()}</div>
    </>
  );
}
