let sequence = 0;

async function readUncachedValue() {
  "use cache";
  const value = `owned-by-public-use-cache-${++sequence}`;
  const response = await fetch(`data:text/plain,${value}`, { cache: "no-store" });
  return response.text();
}

export default async function PublicUseCachePage() {
  return <p>{await readUncachedValue()}</p>;
}
