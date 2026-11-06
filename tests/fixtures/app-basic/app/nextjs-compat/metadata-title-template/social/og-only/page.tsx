import type { Metadata } from "next";

export const metadata: Metadata = {
  openGraph: { title: "OG Only" },
  twitter: { card: "summary" },
};

export default function Page() {
  return <div id="social-title-template-og-only">Social title template og-only page</div>;
}
