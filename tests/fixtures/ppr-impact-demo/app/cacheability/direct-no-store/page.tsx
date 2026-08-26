let directSourceSequence = 0;

export default async function DirectNoStorePage() {
  const value = `direct-no-store-${++directSourceSequence}`;
  const response = await fetch(`data:text/plain,${value}`, { cache: "no-store" });
  return <p id="cacheability-result">{await response.text()}</p>;
}
