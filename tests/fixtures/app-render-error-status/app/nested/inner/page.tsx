import { cookies } from "next/headers";

export default async function NestedThrowPage() {
  await cookies();
  throw new Error("nested page render failed");
}
