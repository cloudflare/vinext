import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Inner Page",
};

export default function Page() {
  return <div id="title-template-inner">Title template inner page</div>;
}
