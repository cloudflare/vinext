import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Extra Page",
};

export default function Page() {
  return <div id="title-template-extra">Title template extra page</div>;
}
