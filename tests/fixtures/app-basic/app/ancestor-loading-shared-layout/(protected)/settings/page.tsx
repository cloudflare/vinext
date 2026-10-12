import { connection } from "next/server";

export default async function SettingsPage() {
  await connection();
  await new Promise((resolve) => setTimeout(resolve, 3000));

  return <h1 id="ancestor-shared-layout-settings">Settings page</h1>;
}
