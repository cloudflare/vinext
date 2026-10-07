import { redirect } from "next/navigation";

export default function PrefetchRedirectStatic() {
  redirect("/nextjs-compat/prefetch-redirect/target");
}
