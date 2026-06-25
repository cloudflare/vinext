export const revalidate = 60;

export async function generateMetadata() {
  await new Promise((resolve) => setTimeout(resolve, 25));
  return {
    title: "Parallel slot dynamic streamed metadata",
    description: "Static metadata follows dynamic parallel slot content",
  };
}

export default function MetadataStreamingParallelDynamicPage() {
  return <div>Static page content</div>;
}
