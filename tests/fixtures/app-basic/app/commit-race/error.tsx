"use client";

export default function CommitRaceError({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div data-testid="commit-race-error">
      <h1>Commit race error</h1>
      <p data-testid="commit-race-error-message">{error.message}</p>
      <button type="button" onClick={reset}>
        Try again
      </button>
    </div>
  );
}
