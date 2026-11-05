import { connection } from "next/server";

export default async function RefreshDuringNavigationStartPage() {
  await connection();
  return (
    <>
      <h1 id="start-page">Start</h1>
      <p id="start-rendered-at">{Date.now()}</p>
      {/* Tall enough to restore a scroll position on back navigation. */}
      <div style={{ height: 3000 }} />
    </>
  );
}
