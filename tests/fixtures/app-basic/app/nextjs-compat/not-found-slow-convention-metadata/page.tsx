import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export const metadata = { title: "Slow convention page" };

export default function Page() {
  notFound();
}
