import type { Metadata } from "next";

export const metadata: Metadata = {
  openGraph: {
    title: {
      template: "%s | OG",
      default: "OG Default",
    },
  },
  twitter: {
    title: {
      template: "%s | TW",
      default: "TW Default",
    },
  },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <div>{children}</div>;
}
