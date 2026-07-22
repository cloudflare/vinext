export default function HomeLayout({ parallelB }: { parallelB: React.ReactNode }) {
  return (
    <main>
      <h3 data-testid="home-layout">(parallelB)</h3>
      <div data-testid="parallelB-slot">{parallelB}</div>
    </main>
  );
}
