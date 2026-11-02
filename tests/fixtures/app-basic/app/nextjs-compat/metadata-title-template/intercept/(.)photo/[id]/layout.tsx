import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Plain",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <div id="title-template-intercept-photo-layout">{children}</div>;
}
