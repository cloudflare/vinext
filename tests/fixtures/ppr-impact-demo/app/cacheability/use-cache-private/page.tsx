async function readPrivateValue() {
  "use cache: private";

  return "owned-by-private-use-cache";
}

let caughtProbeBailouts = 0;

export default async function PrivateUseCachePage() {
  let value: string;
  try {
    value = await readPrivateValue();
  } catch {
    caughtProbeBailouts++;
    value = "caught-private-cache-bailout";
  }
  return (
    <p id="cacheability-result">
      {value}:probe-catches-{caughtProbeBailouts}
    </p>
  );
}
