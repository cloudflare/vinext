let sequence = 0;

export default async function DirectNoStorePage() {
  const value = `direct-no-store-${++sequence}`;
  const response = await fetch(`data:text/plain,${value}`, { cache: "no-store" });
  return <p>{await response.text()}</p>;
}
