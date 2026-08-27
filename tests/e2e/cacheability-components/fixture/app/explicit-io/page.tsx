// `io()` is implemented by vinext for Next.js parity but is not declared by
// the stable Next.js types installed in this fixture yet.
// @ts-expect-error -- experimental Next.js Cache Components API
import { io } from "next/cache";
import { Suspense } from "react";

async function ExplicitIoContent() {
  await io();
  return <p>executed past io boundary</p>;
}

export default function ExplicitIoPage() {
  return (
    <Suspense fallback={<p>explicit io fallback</p>}>
      <ExplicitIoContent />
    </Suspense>
  );
}
