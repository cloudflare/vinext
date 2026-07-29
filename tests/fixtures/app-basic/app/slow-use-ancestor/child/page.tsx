import { cache, use } from "react";

async function getData() {
  await new Promise((resolve) => setTimeout(resolve, 2000));
  return "ready";
}

const getCachedData = cache(getData);

export default function SlowUseChildPage() {
  use(getCachedData());

  return <h1>Nested slow use() Page</h1>;
}
