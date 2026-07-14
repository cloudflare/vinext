import { failedFetchAction, successfulFetchAction } from "../actions";

export default function FetchActionsPage() {
  return (
    <main>
      <h1>Fetch action references</h1>
      <form id="successful-fetch-action" action={successfulFetchAction}>
        <button type="submit">Run successful fetch action</button>
      </form>
      <form id="failed-fetch-action" action={failedFetchAction}>
        <button type="submit">Run failed fetch action</button>
      </form>
    </main>
  );
}
