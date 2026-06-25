import { headers } from "next/headers";

export const revalidate = 60;

export async function generateMetadata() {
  await new Promise((resolve) => setTimeout(resolve, 25));
  return {
    title: "Body dynamic streamed metadata",
    description: "Static metadata follows dynamic page content",
  };
}

export default function MetadataStreamingBodyDynamicPage() {
  return (
    <main>
      Body-only dynamic metadata page
      <NestedDynamicComponent />
    </main>
  );
}

async function NestedDynamicComponent() {
  await new Promise((resolve) => setTimeout(resolve, 25));
  await headers();
  return <div>Nested dynamic component using headers</div>;
}
