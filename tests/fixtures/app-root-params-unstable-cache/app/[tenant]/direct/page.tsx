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
  return <pre id="data">{JSON.stringify(await getTenantData())}</pre>;
}
