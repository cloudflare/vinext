import type { Metadata } from "next";

export const metadata: Metadata = {
  openGraph: {
    title: {
      template: "%s | Extra OG",
      default: "Extra OG Default",
    },
  },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <div>{children}</div>;
}
