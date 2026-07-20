import { Suspense } from "react";

export const revalidate = 60;

async function DeferredContent() {
  const response = await fetch(process.env.TEST_CDN_LATE_DYNAMIC_IO_URL!, {
    next: { revalidate: 60 },
  });
  return <p id="content">content:{await response.text()}</p>;
}

export default function Page() {
  return (
    <main>
      <h1>Deferred static page</h1>
      <Suspense fallback={<p id="loading">loading</p>}>
        <DeferredContent />
      </Suspense>
    </main>
  );
}
