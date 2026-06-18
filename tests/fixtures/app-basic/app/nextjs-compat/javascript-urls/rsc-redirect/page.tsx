import { redirect } from "next/navigation";
import { DANGEROUS_JAVASCRIPT_URL } from "../bad-url";

export default function Page() {
  redirect(DANGEROUS_JAVASCRIPT_URL);
}
