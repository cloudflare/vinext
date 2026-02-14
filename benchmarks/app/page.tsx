export default function Home() {
  const now = new Date().toISOString();
  return (
    <div>
      <h1>Benchmark App</h1>
      <p>Server-rendered at {now}</p>
      <p>This is a realistic benchmark app with 50+ pages, nested layouts, dynamic routes, and client components.</p>
    </div>
  );
}

