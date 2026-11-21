import type { Metadata } from "next";

export const metadata: Metadata = {
  title: {
    template: "%s | Extra Layout",
    default: "extra layout default",
  },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <div>{children}</div>;
}
