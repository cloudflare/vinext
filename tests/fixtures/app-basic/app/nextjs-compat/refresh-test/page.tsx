import { RefreshButton } from "./refresh-button";

export default async function RefreshPage() {
  const time = Date.now();
  return (
    <div>
      <h1>Refresh Test</h1>
      <div id="time">{time}</div>
      <RefreshButton />
    </div>
  );
}
