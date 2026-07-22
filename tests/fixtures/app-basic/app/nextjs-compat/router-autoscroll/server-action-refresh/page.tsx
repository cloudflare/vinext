import { connection } from "next/server";
import { refreshAction } from "./actions";

export default async function ServerActionRefreshPage() {
  await connection();

  const timestamp = Date.now();

  return (
    <>
      <div style={{ height: "200vh" }} />
      <form action={refreshAction}>
        <button id="refresh-button" type="submit">
          Refresh
        </button>
      </form>
      <div id="server-timestamp">{timestamp}</div>
      <div style={{ height: "200vh" }} />
    </>
  );
}
