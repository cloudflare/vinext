import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default function PrefetchRedirectDynamic() {
  redirect("/nextjs-compat/prefetch-redirect/target");
}
