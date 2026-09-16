'use client';

import * as Sentry from '@sentry/nextjs';

function throwFirstPartyError(): void {
  throw new Error('first-party-error');
}

export default function Page() {
  return (
    <button
      id="first-party-error-btn"
      onClick={() => {
        try {
          throwFirstPartyError();
        } catch (e) {
          Sentry.captureException(e);
        }
      }}
    >
      Throw First Party Error
    </button>
  );
}
