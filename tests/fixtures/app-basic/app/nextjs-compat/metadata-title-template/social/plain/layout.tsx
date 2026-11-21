import type { Metadata } from "next";

export const metadata: Metadata = {
  openGraph: { title: "Plain OG" },
  twitter: { description: "Plain TW" },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <div>{children}</div>;
}
