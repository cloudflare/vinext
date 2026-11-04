import { tenant } from "next/root-params";

export async function getTenantData() {
  "use cache";
  const id = String(await tenant());
  return { tenant: id, fillId: Math.random().toString(36).slice(2) };
}
