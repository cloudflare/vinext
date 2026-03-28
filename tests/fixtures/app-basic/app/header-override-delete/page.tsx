import { cookies, headers } from "next/headers";

export default async function HeaderOverrideDeletePage() {
  const requestHeaders = await headers();
  const requestCookies = await cookies();

  return (
    <div>
      <p id="authorization">{requestHeaders.get("authorization") ?? "null"}</p>
      <p id="cookie">{requestHeaders.get("cookie") ?? "null"}</p>
      <p id="middleware-header">{requestHeaders.get("x-from-middleware") ?? "null"}</p>
      <p id="cookie-count">{String(requestCookies.getAll().length)}</p>
    </div>
  );
}
