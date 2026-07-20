import { Suspense } from "react";

export const dynamic = "force-dynamic";

async function NeverSettles() {
  await new Promise<never>(() => {});
  return <p>unreachable</p>;
}

export default function Page() {
  return (
    <main>
      <h1>Never-settling page</h1>
      <Suspense fallback={<p id="loading">loading</p>}>
        <NeverSettles />
      </Suspense>
    </main>
  );
}
