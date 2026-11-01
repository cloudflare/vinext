import { headers } from "next/headers";

async function readPrivateValue() {
  "use cache: private";
  return "private";
}

async function readPublicValue() {
  "use cache";
  return readPrivateValue();
}

export default async function InvalidNestingPage() {
  // Keeps the page out of the prerender, whose build the error would fail.
  await headers();
  return <p>{await readPublicValue()}</p>;
}
