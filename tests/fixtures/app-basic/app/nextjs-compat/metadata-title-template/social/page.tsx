import type { Metadata } from "next";

export const metadata: Metadata = {
  openGraph: { title: "Beside" },
  twitter: { title: "Beside" },
};

export default function Page() {
  return <div id="social-title-template">Social title template page</div>;
}
