import { connection } from "next/server";

export default async function MetadataStreamingConnectionSlot() {
  await new Promise((resolve) => setTimeout(resolve, 25));
  await connection();
  return <div>Dynamic parallel slot using connection</div>;
}
