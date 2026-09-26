import type { Metadata } from "next";

export const metadata: Metadata = {
  title: { default: "Slot Default", template: "%s | Slot" },
};

export default function SlotLayout({ children }: { children: React.ReactNode }) {
  return children;
}
