import { connection } from "next/server";

export default async function RefreshDuringNavigationDestinationPage() {
  await connection();
  return (
    <>
      <h1 id="destination-page">Destination</h1>
      <p id="destination-rendered-at">{Date.now()}</p>
    </>
  );
}
