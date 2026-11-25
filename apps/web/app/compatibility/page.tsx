/**
 * /compatibility — the vinext ↔ Next.js compatibility dashboard for the
 * public Next.js version. `?version=<ref>` is rewritten (next.config.ts) to
 * the unlisted ./version/[version] route, which shows another stored version.
 */
import type { Metadata } from "next";
import { PUBLIC_NEXT_REF } from "@/app/lib/compat-version";
import { CompatibilityDashboard } from "./compatibility-dashboard";

// ISR: rebuild this page at most every 5 minutes. Compat data only changes
// when a nightly deploy-suite run lands, so 5 minutes of staleness is fine
// and keeps the page snappy without re-querying D1 on every request.
export const revalidate = 300;

const title = "Next.js compatibility — vinext";
const description =
  "Track vinext compatibility with the Next.js API surface using results from the Next.js deploy test suite.";

export const metadata: Metadata = {
  title,
  description,
  alternates: {
    canonical: "/compatibility",
  },
  openGraph: {
    type: "website",
    locale: "en_US",
    siteName: "vinext",
    title,
    description,
    url: "/compatibility",
  },
};

export default function CompatibilityPage() {
  return <CompatibilityDashboard nextRef={PUBLIC_NEXT_REF} />;
}
