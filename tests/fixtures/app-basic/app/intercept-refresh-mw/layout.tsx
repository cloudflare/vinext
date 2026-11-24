import { headers } from "next/headers";
import { RefreshButton } from "./refresh-button";

// Middleware hands this layout the pathname of the request that rendered it.
// The sidebar's page at the source's path gives the source its own children
// slot, so a refresh takes the source page from the source's render.
// Coverage: tests/e2e/app-router/interception-refresh-middleware-headers.spec.ts
export default async function Layout({
  children,
  modal,
  sidebar,
}: {
  children: React.ReactNode;
  modal: React.ReactNode;
  sidebar: React.ReactNode;
}) {
  const requestHeaders = await headers();
  return (
    <>
      <p id="owner-mw">mw={requestHeaders.get("x-intercept-refresh-mw")}</p>
      <RefreshButton />
      <div id="sidebar">{sidebar}</div>
      <div id="children">{children}</div>
      <div id="modal">{modal}</div>
    </>
  );
}
