import { connection } from "next/server";
import { Suspense } from "react";
import { LinkAccordion } from "../segment-cache-metadata/link-accordion";
import { refreshDynamicData } from "./actions";

const root = "/nextjs-compat/segment-cache-refresh";

async function DynamicRender() {
  await connection();
  return <div id="dynamic-render">{crypto.randomUUID()}</div>;
}

export default function Page() {
  return (
    <>
      <Suspense fallback="Loading...">
        <DynamicRender />
      </Suspense>
      <form action={refreshDynamicData}>
        <button id="server-refresh-button" type="submit">
          Refresh dynamic data
        </button>
      </form>
      <LinkAccordion href={`${root}/docs`}>Docs</LinkAccordion>
    </>
  );
}
