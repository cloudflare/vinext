async function readPrivateValue() {
  "use cache: private";

  return "owned-by-private-use-cache";
}

export default async function PrivateUseCachePage() {
  return <p id="cacheability-result">{await readPrivateValue()}</p>;
}
