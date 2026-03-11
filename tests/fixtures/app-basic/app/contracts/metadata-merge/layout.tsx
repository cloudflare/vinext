import type { Metadata } from "next";

export const metadata: Metadata = {
  title: {
    template: "%s | Contracts",
    default: "Contracts",
  },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
