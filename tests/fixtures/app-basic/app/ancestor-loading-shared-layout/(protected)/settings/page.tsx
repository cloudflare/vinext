import { connection } from "next/server";

export default async function SettingsPage() {
  await connection();
  await new Promise((resolve) => setTimeout(resolve, 1500));

  return <h1 id="ancestor-shared-layout-settings">Settings page</h1>;
}
