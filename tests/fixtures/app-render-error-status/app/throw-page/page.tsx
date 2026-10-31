import { cookies } from "next/headers";

export default async function ThrowPage() {
  await cookies();
  throw new Error("page render failed");
}
