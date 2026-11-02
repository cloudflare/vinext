import { headers } from "next/headers";

export default async function HeaderResponseMergePage() {
  const requestHeaders = await headers();

  return (
    <main>
      <h1>Header Response Merge</h1>
      <p id="viewer-role">{requestHeaders.get("x-viewer-role")}</p>
      <p id="empty">{requestHeaders.get("x-empty-from-middleware")}</p>
      <p id="set-cookie">{requestHeaders.get("set-cookie")}</p>
    </main>
  );
}
