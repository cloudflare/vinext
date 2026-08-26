let publicSourceSequence = 0;

async function readUncachedValue() {
  "use cache";

  const value = `owned-by-public-use-cache-${++publicSourceSequence}`;
  const response = await fetch(`data:text/plain,${value}`, {
    cache: "no-store",
  });
  return response.text();
}

export default async function PublicUseCachePage() {
  return <p id="cacheability-result">{await readUncachedValue()}</p>;
}
