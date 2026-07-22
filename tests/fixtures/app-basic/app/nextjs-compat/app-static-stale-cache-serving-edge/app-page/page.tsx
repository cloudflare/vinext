export const runtime = "edge";

export default async function Page() {
  const target = process.env.TEST_APP_STATIC_DELAY_TARGET;
  if (!target) {
    throw new Error("Missing TEST_APP_STATIC_DELAY_TARGET");
  }

  const start = Date.now();
  const data = await fetch(target, {
    next: { revalidate: 1 },
  }).then((res) => res.json());
  const fetchDuration = Date.now() - start;

  return (
    <p id="data">
      {JSON.stringify({
        data,
        fetchDuration,
        start,
      })}
    </p>
  );
}
