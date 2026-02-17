import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Page",
};

export default function Page() {
  return <div id="title-template">Title template page</div>;
}
