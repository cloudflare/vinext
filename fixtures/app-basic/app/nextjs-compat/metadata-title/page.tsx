import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "this is the page title",
  description: "this is the layout description",
};

export default function Page() {
  return <div id="title">Title page</div>;
}
