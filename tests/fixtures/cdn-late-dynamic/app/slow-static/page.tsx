import { Suspense } from "react";

export const revalidate = 60;

async function SlowStaticContent() {
  const response = await fetch(`${process.env.TEST_CDN_LATE_DYNAMIC_IO_URL}?delay=750`, {
    next: { revalidate: 60, tags: ["post:slow-static"] },
  });
  return <p id="value">{await response.text()}</p>;
}

export default function Page() {
  return (
    <main>
      <h1>Slow static page</h1>
      <Suspense fallback={<p id="loading">loading</p>}>
        <SlowStaticContent />
      </Suspense>
    </main>
  );
}
