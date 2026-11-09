import { connection } from "next/server";

export default async function ConnectionProbePage() {
  await connection();
  return <p id="connection-probe">live</p>;
}
