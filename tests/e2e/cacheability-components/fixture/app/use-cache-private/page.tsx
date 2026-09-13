import { connection } from "next/server";

async function readPrivateValue() {
  "use cache: private";
  return "owned-by-private-use-cache";
}

let caughtProbeBailouts = 0;

export default async function PrivateUseCachePage() {
  let value: string;
  try {
    [value] = await Promise.all([readPrivateValue(), connection()]);
  } catch {
    caughtProbeBailouts++;
    value = "caught-private-cache-bailout";
  }
  return (
    <p>
      {value}:probe-catches-{caughtProbeBailouts}
    </p>
  );
}
