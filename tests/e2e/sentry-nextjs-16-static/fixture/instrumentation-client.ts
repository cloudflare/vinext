import * as Sentry from '@sentry/nextjs';
import type { Log } from '@sentry/nextjs';

Sentry.init({
  environment: 'qa', // dynamic sampling bias to keep transactions
  dsn: process.env.NEXT_PUBLIC_E2E_TEST_DSN,
  tunnel: `http://localhost:3031/`, // proxy server
  tracesSampleRate: 1.0,
  integrations: [
    Sentry.thirdPartyErrorFilterIntegration({
      filterKeys: ['nextjs-16-static-e2e'],
      behaviour: 'apply-tag-if-contains-third-party-frames',
    }),
  ],
  // Verify Log type is available
  beforeSendLog(log: Log) {
    return log;
  },
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
