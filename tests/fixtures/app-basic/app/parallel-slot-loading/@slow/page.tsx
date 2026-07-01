export default async function SlowSlot() {
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  return <p id="slow-parallel-slot">Slow parallel slot loaded</p>;
}
