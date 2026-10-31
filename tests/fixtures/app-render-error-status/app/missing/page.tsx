import { cookies } from "next/headers";
import { notFound } from "next/navigation";

export default async function MissingPage(): Promise<never> {
  await cookies();
  notFound();
}
