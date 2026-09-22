import { headers } from "next/headers";
import { readRecord } from "./records";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ record?: string }>;
}) {
  const { record = "victim" } = await searchParams;
  const authorization = (await headers()).get("authorization");

  if (authorization !== "Bearer fixture-victim-session") {
    return <main data-testid="hidden-cache-result">FORBIDDEN</main>;
  }

  const result = await readRecord(record);
  return <main data-testid="hidden-cache-result">{result?.secret ?? "NOT_FOUND"}</main>;
}
