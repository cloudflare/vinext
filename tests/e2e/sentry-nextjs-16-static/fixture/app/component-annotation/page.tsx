'use client';

import * as Sentry from '@sentry/nextjs';

export default function ComponentAnnotationTestPage() {
  return (
    <div>
      <button
        id="annotated-btn"
        onClick={() => {
          Sentry.captureException(new Error('component-annotation-test'));
        }}
      >
        Click Me
      </button>
    </div>
  );
}
