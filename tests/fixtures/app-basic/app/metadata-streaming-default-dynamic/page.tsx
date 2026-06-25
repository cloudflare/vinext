export const revalidate = 60;

export async function generateMetadata() {
  await new Promise((resolve) => setTimeout(resolve, 25));
  return {
    title: "Default slot dynamic streamed metadata",
    description: "Static metadata follows an active dynamic default slot",
  };
}

export default function MetadataStreamingDefaultDynamicPage() {
  return <div>Static default-slot page content</div>;
}
