import type { Metadata } from "next";

export const metadata: Metadata = {
  title: { default: "Grouped Layout", template: "%s | Grouped Layout" },
};

export default function GroupedLayout({ children }: { children: React.ReactNode }) {
  return children;
}
