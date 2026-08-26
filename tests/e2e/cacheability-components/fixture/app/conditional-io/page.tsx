// `io()` is implemented by vinext for Next.js parity but is not declared by
// the stable Next.js types installed in this fixture yet.
// @ts-expect-error -- experimental Next.js Cache Components API
import { io } from "next/cache";
import { recordConditionalIoRender, shouldUseConditionalIo } from "./state";

async function establishRouteCacheLife() {
  "use cache";
  return null;
}

export default async function ConditionalIoPage() {
  const render = recordConditionalIoRender();
  const dynamic = shouldUseConditionalIo();
  await establishRouteCacheLife();
  if (dynamic) await io();
  return <p>{`conditional-io:${dynamic ? "dynamic" : "static"}:${render}`}</p>;
}
