import { unstable_cache } from "next/cache";
import { tenant } from "next/root-params";
import { connection } from "next/server";
import { Suspense } from "react";

const getTenant = unstable_cache(async () => tenant(), ["callback-tenant"]);

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
    return <pre id="data">{JSON.stringify(await getTenant())}</pre>;
  } catch (error) {
    return <pre id="error">{(error as Error).message}</pre>;
  }
}
