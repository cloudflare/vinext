async function readUncachedValue() {
  "use cache";

  const response = await fetch("data:text/plain,owned-by-public-use-cache", {
    cache: "no-store",
  });
  return response.text();
}

export default async function PublicUseCachePage() {
  return <p id="cacheability-result">{await readUncachedValue()}</p>;
}
