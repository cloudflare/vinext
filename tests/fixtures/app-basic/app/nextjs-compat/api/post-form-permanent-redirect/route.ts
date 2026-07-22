import { permanentRedirect } from "next/navigation";

export function POST(): void {
  permanentRedirect("/nextjs-compat/route-handler-redirects?success=true");
}
