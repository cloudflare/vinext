import { headers } from "next/headers";

export default async function TeamNotFound() {
  const requestHeaders = await headers();
  return <span data-testid="team-not-found">{requestHeaders.get("user-agent")}</span>;
}
