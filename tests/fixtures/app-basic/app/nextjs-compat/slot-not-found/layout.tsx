export default function Layout({ children, s }: { children: React.ReactNode; s: React.ReactNode }) {
  return (
    <main>
      <h2 id="slot-not-found-layout">slot layout</h2>
      {children}
      <section>{s}</section>
    </main>
  );
}
