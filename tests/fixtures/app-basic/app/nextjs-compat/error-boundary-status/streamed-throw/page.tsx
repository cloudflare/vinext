import { Suspense, type ReactNode } from "react";
import { cookies } from "next/headers";

async function StreamedThrow(): Promise<ReactNode> {
  await cookies();
  await new Promise((resolve) => setTimeout(resolve, 10));
  throw new Error("error-boundary-status streamed render failed");
}

// The throw sits inside Suspense, after the shell and its 200 have been sent,
// so the status stays 200 in Next.js.
export default function StreamedThrowPage() {
  return (
    <div>
      <h1 data-testid="error-boundary-status-streamed-shell">streamed shell</h1>
      <Suspense fallback={<p>Loading...</p>}>
        <StreamedThrow />
      </Suspense>
    </div>
  );
}
