import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default function PrefetchRedirectDynamicAuto() {
  redirect("/nextjs-compat/prefetch-redirect/target");
}
