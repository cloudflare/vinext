import { redirect } from "next/navigation";

export default function LayoutRedirect(): never {
  redirect("/nextjs-compat/prefetch-redirect/target");
}
