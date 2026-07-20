import { Suspense } from "react";
import { cookies } from "next/headers";

export const revalidate = 60;

async function PersonalizedContent() {
  await fetch(process.env.TEST_CDN_LATE_DYNAMIC_IO_URL!, {
    next: { revalidate: 60 },
  });
  const session = (await cookies()).get("session")?.value ?? "anonymous";
  return <p id="session">session:{session}</p>;
}

export default function Page() {
  return (
    <main>
      <h1>Deferred personalized page</h1>
      <Suspense fallback={<p id="loading">loading</p>}>
        <PersonalizedContent />
      </Suspense>
    </main>
  );
}
