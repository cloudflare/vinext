import { use } from "react";

async function getData() {
  await new Promise((resolve) => setTimeout(resolve, 2000));
  return "ready";
}

export default function SlowUseChildPage() {
  use(getData());

  return <h1>Nested slow use() Page</h1>;
}
