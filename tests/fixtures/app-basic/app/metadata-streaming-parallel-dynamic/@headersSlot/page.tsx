import { headers } from "next/headers";

export default function MetadataStreamingHeadersSlot() {
  return <NestedHeadersSlot />;
}

async function NestedHeadersSlot() {
  await new Promise((resolve) => setTimeout(resolve, 25));
  await headers();
  return <div>Nested dynamic parallel slot using headers</div>;
}
