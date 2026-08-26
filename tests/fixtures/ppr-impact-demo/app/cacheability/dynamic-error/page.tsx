import { headers } from "next/headers";

export default async function DynamicErrorPage() {
  await headers();
  throw new Error("dynamic route failed after request API use");
}
