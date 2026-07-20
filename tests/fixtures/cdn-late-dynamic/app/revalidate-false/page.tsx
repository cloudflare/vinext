import { Suspense } from "react";

export const revalidate = false;

async function DeferredContent() {
  const response = await fetch(process.env.TEST_CDN_LATE_DYNAMIC_IO_URL!, {
    next: { revalidate: 60 },
  });
  return <p id="content">content:{await response.text()}</p>;
}

export default function Page() {
  return (
    <main>
      <h1>Indefinitely cached page</h1>
      <Suspense fallback={<p id="loading">loading</p>}>
        <DeferredContent />
      </Suspense>
    </main>
  );
}
