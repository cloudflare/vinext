import { redirect } from "next/navigation";

// redirect() throws during render. The RSC entry should catch this
// and return an HTTP redirect response.
export default function RedirectTestPage() {
  redirect("/about");
}
