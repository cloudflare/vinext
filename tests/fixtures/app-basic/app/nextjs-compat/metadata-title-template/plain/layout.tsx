import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Plain Layout",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <div>{children}</div>;
}
