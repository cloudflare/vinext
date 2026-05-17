import { ErrorBoundary } from "./error-boundary";
import { runAction } from "./actions";

export default function Page() {
  return (
    <main>
      <h1 id="action-forward-loop-page">Action Forward Loop Test</h1>
      <ErrorBoundary>
        <form action={runAction}>
          <button id="run-action" type="submit">
            Run action
          </button>
        </form>
        <p id="action-result"></p>
      </ErrorBoundary>
    </main>
  );
}
