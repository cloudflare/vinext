import { Suspense } from "react";
import { notFound } from "next/navigation";

// An ISR page whose notFound() a Suspense boundary catches, first rendered by
// an RSC request. Its shell renders, so Next.js stores it with status 200.
export const revalidate = 60;

async function NotFound(): Promise<never> {
  await Promise.resolve();
  notFound();
}

export default function Page() {
  return (
    <Suspense fallback={<p>loading</p>}>
      <NotFound />
    </Suspense>
  );
}
