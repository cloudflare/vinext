async function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
export default async function Page() {
  await delay(100);
  return (
    <div>
      <h1 id="async-page">Async Server Component</h1>
      <p id="async-timestamp">{Date.now()}</p>
    </div>
  );
}
