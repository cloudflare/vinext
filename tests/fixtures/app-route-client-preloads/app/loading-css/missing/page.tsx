import { notFound } from "next/navigation";
import { MissingPageNote } from "./missing-page-note";

export const dynamic = "force-dynamic";

export default function MissingPage() {
  notFound();
  return <MissingPageNote />;
}
