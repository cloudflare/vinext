import * as Sentry from '@sentry/nextjs';
import { Log } from '@sentry/nextjs';

Sentry.init({
  // This app is the static counterpart of `nextjs-16`, which streams spans.
  // Do not port it: it exists to keep the static trace lifecycle covered end to end.
  traceLifecycle: 'static',
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
