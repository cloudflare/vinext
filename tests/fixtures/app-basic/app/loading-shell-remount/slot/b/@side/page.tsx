import { sleep } from "../../../sleep";

export default async function Side() {
  await sleep(800);
  return <p id="side">side</p>;
}
