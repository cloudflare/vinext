import * as Sentry from '@sentry/nextjs';
import { Log } from '@sentry/nextjs';

Sentry.init({
  environment: 'qa', // dynamic sampling bias to keep transactions
  dsn: process.env.NEXT_PUBLIC_E2E_TEST_DSN,
  tunnel: `http://localhost:3031/`, // proxy server
  tracesSampleRate: 1.0,
  // debug: true,
  integrations: [Sentry.vercelAIIntegration(), Sentry.nodeRuntimeMetricsIntegration({ collectionIntervalMs: 1_000 })],
  // Verify Log type is available
  beforeSendLog(log: Log) {
    return log;
  },
});
