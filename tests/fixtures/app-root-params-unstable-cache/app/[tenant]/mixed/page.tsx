import { unstable_cache } from "next/cache";
import { connection } from "next/server";
import { Suspense } from "react";
import { getTenantData } from "../../../lib/data";

export default function Page() {
  return (
    <Suspense fallback={<pre id="loading" />}>
      <Body />
    </Suspense>
  );
}

async function Body() {
  await connection();
  try {
    return <pre id="data">{JSON.stringify(await unstable_cache(getTenantData)())}</pre>;
  } catch (error) {
    return <pre id="error">{(error as Error).message}</pre>;
  }
}
