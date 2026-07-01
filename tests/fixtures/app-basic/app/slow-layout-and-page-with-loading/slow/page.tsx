import { use } from "react";

async function getData() {
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  return "Slow page loaded";
}

export default function Page() {
  return <h1 id="slow-page-message">{use(getData())}</h1>;
}
