import React from "react";
// `io()` is implemented by vinext for Next.js parity but is not declared by
// the stable Next.js types installed in this fixture yet.
// @ts-expect-error -- experimental Next.js Cache Components API
import { io } from "next/cache";

const pagesIoRenderCount = Symbol.for("vinext.test.pagesIoRenderCount");
const globalState = globalThis as typeof globalThis & { [pagesIoRenderCount]?: number };

export default function PagesIo() {
  React.use(io());
  globalState[pagesIoRenderCount] = (globalState[pagesIoRenderCount] ?? 0) + 1;
  return <p id="pages-io">pages-io:ok</p>;
}
