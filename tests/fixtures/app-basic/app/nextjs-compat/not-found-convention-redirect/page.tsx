import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export const metadata = { title: "Convention redirect page" };

export default function Page() {
  notFound();
}
