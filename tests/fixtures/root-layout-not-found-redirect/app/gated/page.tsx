import { notFound } from "next/navigation";

// A matched route that calls notFound(), so its not-found boundary renders
// wrapped in the root layout. The root layout may then redirect() during that
// fallback render — the matched-route counterpart to the route-miss case,
// used to prove the RSC drain applies to matched http-access fallbacks too.
export default function Page() {
  notFound();
}
