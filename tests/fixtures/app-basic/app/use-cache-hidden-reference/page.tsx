import { headers } from "next/headers";
import readDefaultRecord, { readRecord } from "./records";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ record?: string; source?: string }>;
}) {
  const { record = "victim", source } = await searchParams;
  const authorization = (await headers()).get("authorization");

  if (authorization !== "Bearer fixture-victim-session") {
    return <main data-testid="hidden-cache-result">FORBIDDEN</main>;
  }

  const result = source === "default" ? await readDefaultRecord(record) : await readRecord(record);
  return <main data-testid="hidden-cache-result">{result?.secret ?? "NOT_FOUND"}</main>;
}
