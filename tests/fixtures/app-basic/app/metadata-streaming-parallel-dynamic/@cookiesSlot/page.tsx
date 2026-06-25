import { cookies } from "next/headers";

export default async function MetadataStreamingCookiesSlot() {
  await new Promise((resolve) => setTimeout(resolve, 25));
  await cookies();
  return <div>Dynamic parallel slot using cookies</div>;
}
