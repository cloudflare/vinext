let callCount = 0;

async function getCachedValue(value: string) {
  "use cache: private";

  callCount++;
  return `${value}:${callCount}`;
}

export default async function Page() {
  const first = await getCachedValue("same");
  const second = await getCachedValue("same");

  return (
    <div>
      <span data-testid="first">{first}</span>
      <span data-testid="second">{second}</span>
    </div>
  );
}
