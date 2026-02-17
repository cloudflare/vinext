import type { Metadata } from "next";

export const metadata: Metadata = {
  title: {
    template: "%s | Layout",
    default: "title template layout default",
  },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <div>{children}</div>;
}
