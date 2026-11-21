import { headers } from "next/headers";

export async function Header() {
  const requestHeaders = await headers();
  if (requestHeaders.get("x-vinext-throw-root-header") === "1") {
    throw new Error("root header failed");
  }
  return <header id="root-header">Header</header>;
}
