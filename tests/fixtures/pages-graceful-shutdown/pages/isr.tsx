import { setTimeout } from "node:timers/promises";

let renders = 0;

// Each render logs when it starts and ends, so a test can tell whether a
// background regeneration finished before the server exited.
export async function getStaticProps() {
  const render = ++renders;
  console.log(`[gsp] start ${render}`);
  await setTimeout(1_500);
  console.log(`[gsp] end ${render}`);
  return { props: { render }, revalidate: 1 };
}

export default function Isr({ render }: { render: number }) {
  return <p>render {render}</p>;
}
