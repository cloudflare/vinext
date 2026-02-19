import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Metadata Not Found Layout Title",
  description: "Layout description for not-found test",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <div id="metadata-not-found-layout">{children}</div>;
}
