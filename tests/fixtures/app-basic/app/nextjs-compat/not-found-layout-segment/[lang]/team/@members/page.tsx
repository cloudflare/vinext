import "./members.css";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function Members(): Promise<never> {
  await Promise.resolve();
  notFound();
}
