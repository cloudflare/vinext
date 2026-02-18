async function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default async function SlowPage() {
  // Delay long enough for loading.tsx Suspense boundary to be visible
  await delay(2000);

  return (
    <main>
      <h1>Slow Page</h1>
      <p>This page has a loading boundary.</p>
    </main>
  );
}
