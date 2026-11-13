// A static page that middleware.ts protects: a visitor without a session is
// redirected before the page renders.
export default function DashboardPage() {
  return (
    <main>
      <h1>Dashboard</h1>
    </main>
  );
}
