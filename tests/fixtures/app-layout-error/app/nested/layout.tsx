import { headers } from "next/headers";

export default async function NestedLayout({ children }: { children: React.ReactNode }) {
  const requestHeaders = await headers();
  if (requestHeaders.get("x-vinext-throw-nested-layout") === "1") {
    throw new Error("nested layout failed");
  }

  return <section id="nested-layout">{children}</section>;
}
