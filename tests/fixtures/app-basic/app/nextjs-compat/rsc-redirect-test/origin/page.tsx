/**
 * Fixture for rsc-redirect test.
 * Ported from: test/e2e/app-dir/rsc-redirect/app/origin/page.tsx
 */
import { redirect } from "next/navigation";

export default function Page(): never {
  redirect("/nextjs-compat/rsc-redirect-test/dest");
}
