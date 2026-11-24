import { connection } from "next/server";

export default async function RefreshDuringNavigationRedirectTargetPage() {
  await connection();
  return (
    <>
      <h1 id="redirect-target-page">Redirect target</h1>
      <p id="redirect-target-rendered-at">{Date.now()}</p>
    </>
  );
}
