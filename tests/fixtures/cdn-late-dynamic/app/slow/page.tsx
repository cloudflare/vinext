import { Suspense } from "react";
import { cookies } from "next/headers";

export const revalidate = 60;

async function SlowContent() {
  await fetch(`${process.env.TEST_CDN_LATE_DYNAMIC_IO_URL}?delay=750&kind=dynamic`, {
    next: { revalidate: 60 },
  });
  const session = (await cookies()).get("session")?.value ?? "anonymous";
  return <p id="session">session:{session}</p>;
}

export default function Page() {
  return (
    <main>
      <h1>Slow deferred page</h1>
      <Suspense fallback={<p id="loading">loading</p>}>
        <SlowContent />
      </Suspense>
    </main>
  );
}
