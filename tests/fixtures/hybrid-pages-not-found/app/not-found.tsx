import { Suspense } from "react";
import { cookies } from "next/headers";

async function Marker() {
  const cookieStore = await cookies();
  return <p id="marker">{cookieStore.get("not-found-marker")?.value ?? "missing"}</p>;
}

export default function NotFound() {
  return (
    <main>
      <h1>APP ROUTER - 404 PAGE</h1>
      <Suspense fallback={<p>Loading not-found content...</p>}>
        <Marker />
      </Suspense>
    </main>
  );
}
