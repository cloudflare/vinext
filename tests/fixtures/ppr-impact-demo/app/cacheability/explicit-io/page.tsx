// `io()` is implemented by vinext for Next.js parity but is not declared by
// the stable Next.js types installed in this fixture yet.
// @ts-expect-error -- experimental Next.js Cache Components API
import { io } from "next/cache";

export const revalidate = 60;

export default async function ExplicitIoPage() {
  // Next.js resolves io() immediately in a prerender-legacy work unit. It only
  // suspends and makes the route dynamic when Cache Components are enabled.
  await io();
  return <p id="cacheability-result">legacy io completed</p>;
}
