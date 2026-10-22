import "./roles.css";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function RolesLayout(_props: { children: React.ReactNode }): Promise<never> {
  await Promise.resolve();
  notFound();
}
