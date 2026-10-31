import { Suspense } from "react";
import { cookies } from "next/headers";

async function LateThrow(): Promise<never> {
  await cookies();
  await new Promise((resolve) => setTimeout(resolve, 50));
  throw new Error("late render failed");
}

export default function SuspenseThrowPage() {
  return (
    <div>
      <p id="shell">shell</p>
      <Suspense fallback={<p>loading</p>}>
        <LateThrow />
      </Suspense>
    </div>
  );
}
