// `io()` is implemented by vinext for Next.js parity but is not declared by
// the stable Next.js types installed in this fixture yet.
// @ts-expect-error -- experimental Next.js Cache Components API
import { io } from "next/cache";

async function readCachedValue() {
  "use cache";
  await io();
  return "io resolved inside use cache";
}

export default async function IoInUseCachePage() {
  return <p>{await readCachedValue()}</p>;
}
