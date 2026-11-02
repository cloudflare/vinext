import { redirect } from "next/navigation";

export const revalidate = 60;

// Next.js stores this redirect with the absolute target as written, and
// answers every host the app serves from that one entry.
export default function SpecialErrorAbsoluteRedirectPage() {
  redirect("https://tenant-a.test/static-default");
}
