import { cookies } from "next/headers";

export default function MetadataStreamingDynamicDefaultSlot() {
  return <NestedDynamicDefaultSlot />;
}

async function NestedDynamicDefaultSlot() {
  await new Promise((resolve) => setTimeout(resolve, 25));
  await cookies();
  return <div>Nested dynamic active default slot using cookies</div>;
}
