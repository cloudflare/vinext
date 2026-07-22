export default function GroupALayout({ parallel }: { parallel: React.ReactNode }) {
  return (
    <div data-testid="group-a-layout">
      <div data-testid="group-a-parallel-slot">{parallel}</div>
    </div>
  );
}
