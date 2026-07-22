export default async function SlowSlotPage() {
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  return <p id="slow-slot-message">Slow named slot resolved</p>;
}
