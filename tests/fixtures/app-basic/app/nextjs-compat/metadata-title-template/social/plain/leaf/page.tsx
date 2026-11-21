import type { Metadata } from "next";

export const metadata: Metadata = {
  openGraph: { title: "Leaf" },
  twitter: { title: "Leaf" },
};

export default function Page() {
  return <div id="social-title-template-plain-leaf">Social title template plain leaf page</div>;
}
