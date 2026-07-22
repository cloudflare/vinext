export const revalidate = 1;

export default async function Page() {
  const target = process.env.TEST_APP_STATIC_REVALIDATE_TARGET;
  if (!target) {
    throw new Error("Missing TEST_APP_STATIC_REVALIDATE_TARGET");
  }

  const data = await fetch(target, {
    next: { revalidate: 2 },
  }).then((res) => res.text());

  return (
    <>
      <p id="date">{Date.now()}</p>
      <p id="random-data">{data}</p>
    </>
  );
}
