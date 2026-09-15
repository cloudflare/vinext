import * as Sentry from '@sentry/nextjs';
import { use } from 'react';
export const dynamic = 'force-dynamic';

export default async function Page() {
  try {
    use(fetch('https://example.com/'));
  } catch (e) {
    Sentry.captureException(e); // This error should not be reported
    await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for any async event processors to run
    await Sentry.flush();
  }

  return <p>test</p>;
}
