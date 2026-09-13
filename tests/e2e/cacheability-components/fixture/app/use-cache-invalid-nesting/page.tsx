async function readPrivateValue() {
  "use cache: private";
  return "private";
}

async function readPublicValue() {
  "use cache";
  return readPrivateValue();
}

export default async function InvalidNestingPage() {
  return <p>{await readPublicValue()}</p>;
}
