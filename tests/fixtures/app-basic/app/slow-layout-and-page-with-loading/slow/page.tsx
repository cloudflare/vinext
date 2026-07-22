async function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default async function SlowPage() {
  await delay(2000);

  return <h1 id="slow-combined-page-message">Slow page resolved</h1>;
}
