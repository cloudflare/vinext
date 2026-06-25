import { connection } from "next/server";

export async function generateMetadata() {
  await connection();
  await new Promise((resolve) => setTimeout(resolve, 25));
  return {
    title: "Dynamic streamed metadata",
    description: "Dynamic metadata remains streamed",
  };
}

export default function MetadataStreamingDynamicPage() {
  return <main>Dynamic metadata page</main>;
}
