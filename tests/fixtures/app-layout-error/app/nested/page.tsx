import { headers } from "next/headers";

export default async function NestedPage() {
  const requestHeaders = await headers();
  if (requestHeaders.get("x-vinext-throw-nested-page") === "1") {
    throw new Error("nested page failed");
  }

  return <p id="nested-page">Nested Page</p>;
}
