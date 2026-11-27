import type { Metadata, ResolvingMetadata } from "next";

export async function generateMetadata(
  _props: unknown,
  parent: ResolvingMetadata,
): Promise<Metadata> {
  const resolved = await parent;
  return {
    title: "Metadata Extra Fields Parent",
    other: {
      "parent-assets": resolved.assets?.join(",") ?? "",
      "parent-facebook-admins": resolved.facebook?.admins?.join(",") ?? "",
    },
  };
}

export default function MetadataExtraFieldsParentPage() {
  return <h1>Metadata Extra Fields Parent</h1>;
}
