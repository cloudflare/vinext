import { redirect } from "next/navigation";

export const revalidate = 60;

export function GET() {
  redirect("/static-default");
}
