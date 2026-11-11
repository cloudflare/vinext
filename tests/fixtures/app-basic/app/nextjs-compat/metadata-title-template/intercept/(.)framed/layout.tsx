import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Mid",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <div id="title-template-intercept-framed-layout">{children}</div>;
}
