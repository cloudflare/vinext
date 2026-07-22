function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function delayForTarget(target: string): number {
  switch (target) {
    case "a":
      return 500;
    case "b":
      return 300;
    case "c":
      return 0;
    default:
      return 0;
  }
}

export default async function RaceTargetPage({ params }: { params: Promise<{ target: string }> }) {
  const { target } = await params;
  await sleep(delayForTarget(target));

  return (
    <>
      <button data-testid="race-target" style={{ marginLeft: 1000 }}>
        Race target {target}
      </button>
      <div style={{ height: 1, width: 10000 }} />
      {Array.from({ length: 500 }, (_, index) => (
        <div key={index}>
          Race target {target} row {index}
        </div>
      ))}
    </>
  );
}
