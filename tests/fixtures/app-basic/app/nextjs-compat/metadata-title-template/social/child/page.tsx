import type { Metadata, ResolvingMetadata } from "next";

export async function generateMetadata(
  _props: unknown,
  parent: ResolvingMetadata,
): Promise<Metadata> {
  const resolved = await parent;
  return {
    openGraph: { title: "Child" },
    twitter: { title: "Child" },
    other: {
      "parent-og-title": JSON.stringify(resolved.openGraph?.title),
      "parent-twitter-title": JSON.stringify(resolved.twitter?.title),
    },
  };
}

export default function Page() {
  return <div id="social-title-template-child">Social title template child page</div>;
}
