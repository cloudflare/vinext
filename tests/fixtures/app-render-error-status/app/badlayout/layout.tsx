import { cookies } from "next/headers";

export default async function BadLayout(_props: { children: React.ReactNode }) {
  await cookies();
  throw new Error("nested layout failed");
}
